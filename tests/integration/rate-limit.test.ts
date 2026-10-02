import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { TestCookieStore, form, withRequest } from '../helpers/request';
import type { Database } from '@/db/client';
import { loginAttempts, users } from '@/db/schema';
import { TRUSTED_PROXIES_VARIABLE } from '@/lib/env';
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

/**
 * Runs `body` with TABS_TRUSTED_PROXIES set — or, at 0, explicitly not set. Nothing in the
 * header is trusted unless an operator declares how many proxies append to it, so this is how
 * a test says "there is one trusted edge in front of this app" and how it says "there is not".
 */
async function behindProxies<T>(hops: number, body: () => Promise<T>): Promise<T> {
  const previous = process.env[TRUSTED_PROXIES_VARIABLE];
  if (hops > 0) process.env[TRUSTED_PROXIES_VARIABLE] = String(hops);
  else delete process.env[TRUSTED_PROXIES_VARIABLE];
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[TRUSTED_PROXIES_VARIABLE];
    else process.env[TRUSTED_PROXIES_VARIABLE] = previous;
  }
}

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
    const result = await behindProxies(1, () =>
      attempt('victim@example.invalid', 'whatever', { 'x-forwarded-for': '203.0.113.7' }),
    );

    // Refused without the password ever being compared — the whole reason this limit exists.
    expect(result).toEqual({ ok: false, formError: GENERIC_AUTH_ERROR });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rotating the caller-supplied part of the chain buys no fresh bucket', async () => {
    // The limit exists to ration scrypt, so keying it on something the caller sends makes it
    // switchable: a flood that varies what it claims to be gets an empty bucket every time and
    // buys an unbounded number of full password comparisons.
    for (let attemptNumber = 1; attemptNumber <= SOURCE_LIMIT; attemptNumber += 1) {
      await recordAttempt(`flood-${attemptNumber}@example.invalid`, '70.41.3.18', false);
    }

    const spy = vi.spyOn(await import('@/lib/auth'), 'verifyPassword');
    // One trusted edge, so the address is the LAST entry: the one the edge saw. The leading
    // entries are whatever the caller put there, and changing them changes nothing.
    const attempts = await behindProxies(1, async () => {
      const seen = [];
      for (let attemptNumber = 1; attemptNumber <= SOURCE_LIMIT; attemptNumber += 1) {
        seen.push(await attempt('victim@example.invalid', 'whatever', {
          'x-forwarded-for': `198.51.100.${attemptNumber}, 70.41.3.18`,
        }));
      }
      return seen;
    });

    expect(spy).not.toHaveBeenCalled();
    for (const result of attempts) expect(result).toEqual({ ok: false, formError: GENERIC_AUTH_ERROR });
  }, 120_000);

  it('a chain shorter than the declared proxy count says nothing, so the address stays undetermined', async () => {
    for (let attemptNumber = 1; attemptNumber <= SOURCE_LIMIT; attemptNumber += 1) {
      await recordAttempt(`flood-${attemptNumber}@example.invalid`, '198.51.100.1', false);
    }

    // Two proxies are declared but the chain carries one entry, so nothing in it was written
    // by a trusted hop — and the entry the caller did send is exactly what must not be read.
    const result = await behindProxies(2, () =>
      attempt('victim@example.invalid', 'whatever', { 'x-forwarded-for': '198.51.100.1' }),
    );

    expect(result).toEqual({ ok: false, formError: GENERIC_AUTH_ERROR });
    const recorded = await db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.keyHash, keyFor('victim@example.invalid')));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.sourceHash).toBe('');
  }, 60_000);

  it('trusts no header at all until an operator declares a proxy', async () => {
    for (let attemptNumber = 1; attemptNumber <= SOURCE_LIMIT; attemptNumber += 1) {
      await recordAttempt(`flood-${attemptNumber}@example.invalid`, '203.0.113.7', false);
    }

    // Nothing declared, nothing trusted — so a caller cannot opt itself back into the bucket it
    // is trying to escape by sending a header, and cannot refill it either.
    const result = await behindProxies(0, () =>
      attempt('victim@example.invalid', 'whatever', { 'x-forwarded-for': '203.0.113.7' }),
    );

    const recorded = await db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.keyHash, keyFor('victim@example.invalid')));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.sourceHash).toBe('');
    expect(result.formError).toBe(GENERIC_AUTH_ERROR);
  }, 60_000);

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