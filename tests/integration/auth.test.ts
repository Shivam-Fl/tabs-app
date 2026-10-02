import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { TestCookieStore, captureRedirect, form, withRequest } from '../helpers/request';
import type { Database } from '@/db/client';
import { sessions, users } from '@/db/schema';
import { signIn, signOut, signUp } from '@/app/actions/auth';
import { updateProfile } from '@/app/actions/profile';
import { SESSION_COOKIE, hashPassword, hashToken, requireUser, resolveSession } from '@/lib/auth';

const PASSWORD = 'correct horse battery staple';

let db: Database;

beforeEach(async () => {
  db = await useTestDatabase();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeTestDatabase();
});

async function signUpAs(email: string, displayName = 'A Person'): Promise<TestCookieStore> {
  const cookies = new TestCookieStore();
  const result = await withRequest(cookies, () =>
    signUp(null, form({ displayName, email, password: PASSWORD })),
  );
  expect(result).toMatchObject({ ok: true, redirectTo: '/' });
  return cookies;
}

describe('sign-up', () => {
  it('creates the user and its session, and the raw cookie value appears in no row', async () => {
    const email = 'founder@example.invalid';
    const cookies = await signUpAs(email, 'The Founder');

    const accounts = await db.select().from(users);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.email).toBe(email);
    expect(accounts[0]?.displayName).toBe('The Founder');
    expect(accounts[0]?.passwordHash).not.toContain(PASSWORD);

    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(cookies.get(SESSION_COOKIE)?.value ?? ''));

    // The cookie's own value is nowhere in the database, in any table.
    const raw = cookies.get(SESSION_COOKIE)?.value ?? '';
    expect(raw.length).toBeGreaterThan(20);
    expect(JSON.stringify({ accounts, rows })).not.toContain(raw);
  });

  it('trims and lowercases the email before the unique constraint, so two spellings are one account', async () => {
    await signUpAs('qa1@example.invalid');

    const duplicate = await withRequest(new TestCookieStore(), () =>
      signUp(null, form({ displayName: 'Someone Else', email: '  QA1@Example.Invalid ', password: PASSWORD })),
    );

    expect(duplicate).toEqual({
      ok: false,
      fieldErrors: { email: 'An account with that email already exists.' },
    });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it('a double submit yields exactly one account and a field-level message, never a 500', async () => {
    // Both submits start before either has inserted: the unique constraint is what settles it,
    // not the read that precedes it.
    const both = await Promise.all([
      withRequest(new TestCookieStore(), () =>
        signUp(null, form({ displayName: 'First', email: 'double@example.invalid', password: PASSWORD })),
      ),
      withRequest(new TestCookieStore(), () =>
        signUp(null, form({ displayName: 'Second', email: 'double@example.invalid', password: PASSWORD })),
      ),
    ]);

    const succeeded = both.filter((result) => result.ok);
    const refused = both.filter((result) => !result.ok);

    expect(await db.select().from(users)).toHaveLength(1);
    expect(succeeded.length).toBe(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toEqual({
      ok: false,
      fieldErrors: { email: 'An account with that email already exists.' },
    });
  }, 60_000);

  it('reports a malformed email as a field error rather than storing it', async () => {
    const result = await withRequest(new TestCookieStore(), () =>
      signUp(null, form({ displayName: 'A', email: 'not-an-email', password: 'short' })),
    );

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.email).toBeTruthy();
    expect(result.fieldErrors?.password).toBeTruthy();
    expect(await db.select().from(users)).toHaveLength(0);
  });
});

describe('sign-out', () => {
  it('deletes the session row, clears the cookie, and makes the replayed value unauthenticated', async () => {
    const cookies = await signUpAs('leaving@example.invalid');
    const raw = cookies.get(SESSION_COOKIE)?.value ?? '';
    expect(await resolveSession(raw)).not.toBeNull();

    const target = await captureRedirect(() => withRequest(cookies, () => signOut()));

    expect(target).toBe('/sign-in');
    expect(cookies.last).toMatchObject({ name: SESSION_COOKIE, value: '' });
    expect(await db.select().from(sessions)).toHaveLength(0);

    // Replaying the old cookie resolves to nobody, which is what / does with it.
    expect(await resolveSession(raw)).toBeNull();
  }, 60_000);

  it('requireUser redirects to sign-in rather than throwing', async () => {
    const cookies = await signUpAs('signed-in@example.invalid', 'Signed In');
    await withRequest(cookies, async () => {
      expect((await requireUser()).displayName).toBe('Signed In');
    });

    await captureRedirect(async () => {
      await withRequest(new TestCookieStore(), async () => {
        await requireUser();
      });
    }).then((redirected) => expect(redirected).toBe('/sign-in'));
  }, 60_000);
});

describe('sign-in', () => {
  it('accepts the right password and refuses the wrong one with the generic message', async () => {
    await signUpAs('real@example.invalid');

    const wrong = await withRequest(new TestCookieStore(), () =>
      signIn(null, form({ email: 'real@example.invalid', password: 'not the password' })),
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.formError).toBeTruthy();

    const right = await withRequest(new TestCookieStore(), () =>
      signIn(null, form({ email: 'real@example.invalid', password: PASSWORD })),
    );
    expect(right).toMatchObject({ ok: true, redirectTo: '/' });
  }, 60_000);
});

describe('the profile', () => {
  it('normalises a currency code to three uppercase letters', async () => {
    const cookies = await signUpAs('profile@example.invalid');
    await withRequest(cookies, () =>
      updateProfile(null, form({ displayName: 'Renamed', defaultCurrency: 'usd' })),
    ).then((result) => expect(result).toEqual({ ok: true }));

    const [row] = await db.select().from(users).where(eq(users.email, 'profile@example.invalid'));
    expect(row?.displayName).toBe('Renamed');
    expect(row?.defaultCurrency).toBe('USD');
  }, 60_000);

  it("refuses 'EURO' and 'US$' with a field error and changes nothing — no silent truncation", async () => {
    const cookies = await signUpAs('currency@example.invalid');
    const before = await db.select().from(users);

    for (const bad of ['EURO', 'US$', 'EU', '']) {
      const result = await withRequest(cookies, () =>
        updateProfile(null, form({ displayName: 'Renamed', defaultCurrency: bad })),
      );
      expect(result.ok).toBe(false);
      expect(result.fieldErrors?.defaultCurrency).toBeTruthy();
    }

    // Not 'EUR', not 'US', not lowercased: the stored row is untouched.
    expect(await db.select().from(users)).toEqual(before);
  }, 60_000);

  it('refuses an empty display name, and changes nothing', async () => {
    const cookies = await signUpAs('named@example.invalid');
    const before = await db.select().from(users);

    const result = await withRequest(cookies, () => updateProfile(null, form({ displayName: '   ', defaultCurrency: 'EUR' })));
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.displayName).toBeTruthy();
    expect(await db.select().from(users)).toEqual(before);
  }, 60_000);

  it('cannot update another user’s row: the row it writes is the caller’s own', async () => {
    const mine = await signUpAs('mine@example.invalid', 'Mine');
    const theirsEmail = 'theirs@example.invalid';
    await db.insert(users).values({
      email: theirsEmail,
      passwordHash: hashPassword(PASSWORD),
      displayName: 'Theirs',
      defaultCurrency: 'GBP',
    });

    await withRequest(mine, () => updateProfile(null, form({ displayName: 'Mine Renamed', defaultCurrency: 'eur' })));

    const [theirs] = await db.select().from(users).where(eq(users.email, theirsEmail));
    expect(theirs?.displayName).toBe('Theirs');
    expect(theirs?.defaultCurrency).toBe('GBP');
  }, 60_000);

  it('refuses to write anything at all with no session', async () => {
    const before = await db.select().from(users);

    await captureRedirect(() =>
      withRequest(new TestCookieStore(), () => updateProfile(null, form({ displayName: 'Intruder', defaultCurrency: 'USD' }))),
    ).then((redirected) => expect(redirected).toBe('/sign-in'));

    expect(await db.select().from(users)).toEqual(before);
  }, 60_000);
});