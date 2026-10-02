import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { TestCookieStore, form, withRequest } from '../helpers/request';
import type { Database } from '@/db/client';
import { loginAttempts, users } from '@/db/schema';
import { signIn, signUp } from '@/app/actions/auth';
import {
  ACCOUNT_LIMIT,
  GENERIC_AUTH_ERROR,
  SOURCE_LIMIT,
  keyFor,
  recordAttempt,
  sourceFor,
} from '@/lib/auth';

const PASSWORD = 'correct horse battery staple';

let db: Database;

beforeEach(async () => {
  db = await useTestDatabase();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeTestDatabase();
});

async function createAccount(email: string): Promise<void> {
  const cookies = new TestCookieStore();
  const result = await withRequest(cookies, () => signUp(null, form({ displayName: 'A Person', email, password: PASSWORD })));
  expect(result).toMatchObject({ ok: true });
}

/** A sign-in attempt. The headers are what the source limit reads. */
async function attempt(email: string, password: string, headers: Record<string, string> = {}) {
  return withRequest(new TestCookieStore(), () => signIn(null, form({ email, password })), headers);
}

/** Only the rows both predicates count: TR-11's subject is failed sign-ins. */
const failureRowsFor = async (email: string) =>
  (await db.select().from(loginAttempts).where(eq(loginAttempts.keyHash, keyFor(email)))).filter((row) => !row.succeeded);

describe('the account limit', () => {
  const email = 'qa1@example.invalid';

  it(`records six failure rows, refuses the seventh with the identical result, and accepts the correct password next`, async () => {
    await createAccount(email);

    const firstSix = [];
    for (let attemptNumber = 1; attemptNumber <= ACCOUNT_LIMIT; attemptNumber += 1) {
      firstSix.push(await attempt(email, 'wrong on purpose'));
    }

    expect(firstSix).toHaveLength(ACCOUNT_LIMIT);
    expect(await failureRowsFor(email)).toHaveLength(ACCOUNT_LIMIT);

    // The seventh wrong attempt inside the window: refused, and nothing more recorded.
    const seventh = await attempt(email, 'wrong on purpose');
    expect(seventh).toEqual(firstSix[0]);
    expect(await failureRowsFor(email)).toHaveLength(ACCOUNT_LIMIT);

    // The point of the limit: a correct password is accepted however many failures precede it.
    const correct = await attempt(email, PASSWORD);
    expect(correct).toMatchObject({ ok: true, redirectTo: '/' });

    // And the account's failure rows are cleared, so the bucket is not left polluted.
    expect(await failureRowsFor(email)).toHaveLength(0);
    const succeeded = await db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.keyHash, keyFor(email)));
    expect(succeeded.filter((row) => row.succeeded)).toHaveLength(1);
  }, 120_000);

  it('an unknown email and a wrong password produce byte-identical results and messages', async () => {
    await createAccount(email);

    const unknown = await attempt('nobody@example.invalid', 'wrong on purpose');
    const wrongPassword = await attempt(email, 'wrong on purpose');

    expect(unknown).toEqual(wrongPassword);
    expect(unknown.formError).toBe(GENERIC_AUTH_ERROR);

    // The rendered message, compared as bytes rather than as an object.
    const render = (result: Awaited<ReturnType<typeof attempt>>) => JSON.stringify(result);
    expect(render(unknown)).toBe(render(wrongPassword));
  }, 60_000);
});

describe('the source limit', () => {
  it(`refuses the twenty-first attempt from one address without verifying the password at all`, async () => {
    // Twenty failures from one address. On a loopback boot the action only learns the address
    // from a proxy header, so the bucket is filled through the same predicate it reads.
    for (let attemptNumber = 1; attemptNumber <= SOURCE_LIMIT; attemptNumber += 1) {
      await recordAttempt(`flood-${attemptNumber}@example.invalid`, '203.0.113.7', false);
    }

    const spy = vi.spyOn(await import('@/lib/auth'), 'verifyPassword');
    const result = await attempt('victim@example.invalid', 'whatever', { 'x-forwarded-for': '203.0.113.7' });

    // Refused without the password ever being compared — the whole reason this limit exists.
    expect(result).toEqual({ ok: false, formError: GENERIC_AUTH_ERROR });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a request whose source address cannot be determined is exempt from that bucket', async () => {
    await createAccount('exempt@example.invalid');

    // Twenty failures from an address exist, but this request carries no address at all — the
    // loopback case QA sees — so only the account limit can speak, and it is empty.
    for (let attemptNumber = 1; attemptNumber <= SOURCE_LIMIT; attemptNumber += 1) {
      await recordAttempt(`flood-${attemptNumber}@example.invalid`, '203.0.113.7', false);
    }

    const result = await attempt('exempt@example.invalid', 'wrong on purpose');
    expect(result).toEqual({ ok: false, formError: GENERIC_AUTH_ERROR });
    expect(await failureRowsFor('exempt@example.invalid')).toHaveLength(1);
  }, 60_000);

  it('an account that is merely busy is NOT skipped, because only the source limit saves work', async () => {
    await createAccount('busy@example.invalid');
    for (let attemptNumber = 1; attemptNumber <= ACCOUNT_LIMIT; attemptNumber += 1) {
      await attempt('busy@example.invalid', 'wrong on purpose');
    }

    const spy = vi.spyOn(await import('@/lib/auth'), 'verifyPassword');
    await attempt('busy@example.invalid', 'wrong on purpose');

    // The account limit refuses a wrong password; it never locks a correct one out, and it
    // saves no CPU, so the verification still ran.
    expect(spy).toHaveBeenCalled();
  }, 60_000);

  it('a successful sign-in does not count against the source bucket', async () => {
    const address = '203.0.113.9';
    const email = 'regular@example.invalid';
    await createAccount(email);

    for (let signInNumber = 1; signInNumber <= SOURCE_LIMIT * 2; signInNumber += 1) {
      await recordAttempt(email, address, true);
    }

    const rows = await db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.sourceHash, sourceFor(address) as string));
    expect(rows.length).toBeGreaterThanOrEqual(SOURCE_LIMIT);
    expect(rows.every((row) => row.succeeded)).toBe(true);

    // Twenty-four successes and the bucket is still empty, because both predicates count
    // succeeded = false only.
    const failures = rows.filter((row) => !row.succeeded);
    expect(failures).toHaveLength(0);
  }, 120_000);
});

describe('every attempt writes a row', () => {
  it('with its true succeeded value, and stores no email or address in the clear', async () => {
    const email = 'recorded@example.invalid';
    await createAccount(email);

    await attempt(email, 'wrong on purpose');
    // A failed attempt is a row with its true value, kept.
    expect(await failureRowsFor(email)).toHaveLength(1);

    await attempt(email, PASSWORD);
    const rows = await db.select().from(loginAttempts);
    const emailRows = rows.filter((row) => row.keyHash === keyFor(email));

    // The success is a row too, and the failure it replaced is cleared.
    expect(emailRows.filter((row) => row.succeeded)).toHaveLength(1);
    expect(emailRows.filter((row) => !row.succeeded)).toHaveLength(0);

    // Nothing in the table is an email or an address in the clear.
    expect(JSON.stringify(rows)).not.toContain(email);
    const addressed = await db.execute(sql`SELECT count(*)::int AS c FROM login_attempts WHERE "source_hash" = ''`);
    expect(addressed.rows[0]?.c).toBeGreaterThan(0);
  }, 60_000);

  it('sign-up writes a user and a session, and nothing else', async () => {
    const email = 'fresh@example.invalid';
    const cookies = new TestCookieStore();
    await withRequest(cookies, () => signUp(null, form({ displayName: 'Fresh', email, password: PASSWORD })));

    const accounts = await db.select().from(users).where(eq(users.email, email));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.displayName).toBe('Fresh');
    expect(cookies.last?.name).toBe('tabs_session');
  });
});