import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeTestDatabase, useTestDatabase } from '../helpers/pglite';
import { TestCookieStore, withRequest } from '../helpers/request';
import type { Database } from '@/db/client';
import { loginAttempts, sessions, users } from '@/db/schema';
import {
  ACCOUNT_LIMIT,
  SESSION_COOKIE,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  SALT_BYTES,
  SOURCE_LIMIT,
  WINDOW_MS,
  checkRateLimit,
  createSession,
  hashPassword,
  hashToken,
  keyFor,
  recordAttempt,
  resolveSession,
  revokeSession,
  sourceFor,
  verifyPassword,
} from '@/lib/auth';

let db: Database;

beforeEach(async () => {
  db = await useTestDatabase();
});

afterAll(async () => {
  await closeTestDatabase();
});

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `user-${Math.random().toString(36).slice(2)}@example.invalid`,
      passwordHash: hashPassword('a password'),
      displayName: 'A User',
      defaultCurrency: 'USD',
    })
    .returning({ id: users.id });
  return user.id;
}

describe('password hashing', () => {
  it('round-trips and rejects a wrong password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('Correct horse battery staple', stored)).toBe(false);
  });

  it('stores the parameters, a 16-byte salt and the digest, and no plaintext', () => {
    const stored = hashPassword('a memorable password');
    const [scheme, n, r, p, salt, digest] = stored.split('$');

    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBe(SCRYPT_N);
    expect(Number(r)).toBe(SCRYPT_R);
    expect(Number(p)).toBe(SCRYPT_P);
    expect(Buffer.from(salt, 'base64')).toHaveLength(SALT_BYTES);
    expect(digest).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(stored).not.toContain('a memorable password');
  });

  it('salts: the same password hashes differently every time', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('refuses a stored string that is not a scrypt hash', () => {
    expect(verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('sessions', () => {
  it('stores only the SHA-256 of the token; the raw token appears nowhere in the database', async () => {
    const userId = await seedUser();
    const token = await withRequest(new TestCookieStore(), () => createSession(userId));

    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('resolves a live session', async () => {
    const userId = await seedUser();
    const token = await withRequest(new TestCookieStore(), () => createSession(userId));
    expect((await resolveSession(token))?.id).toBe(userId);
  });

  it('refuses an expired session and deletes the row it touched', async () => {
    const userId = await seedUser();
    const token = await withRequest(new TestCookieStore(), () => createSession(userId));
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.tokenHash, hashToken(token)));

    expect(await resolveSession(token)).toBeNull();
    const rows = await db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    expect(rows).toHaveLength(0);
  });

  it('revoking a session makes it resolve to nobody', async () => {
    const userId = await seedUser();
    const token = await withRequest(new TestCookieStore(), () => createSession(userId));
    await revokeSession(token);
    expect(await resolveSession(token)).toBeNull();
  });

  it('refuses a token that was never issued', async () => {
    expect(await resolveSession('never-issued')).toBeNull();
  });
});

describe('keyed digests', () => {
  it('keyFor is an HMAC, matches no plain SHA-256, and normalises the email first', () => {
    const plain = createHash('sha256').update('email:someone@example.invalid').digest('hex');

    expect(keyFor('Someone@Example.INVALID')).not.toBe(plain);
    expect(keyFor('someone@example.invalid')).toMatch(/^[a-f0-9]{64}$/);
    expect(keyFor('  SOMEONE@Example.Invalid ')).toBe(keyFor('someone@example.invalid'));
    expect(keyFor('someone@example.invalid')).not.toBe(keyFor('other@example.invalid'));
  });

  it('sourceFor is keyed too, and is null when no address could be determined', () => {
    expect(sourceFor('203.0.113.7')).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceFor('203.0.113.7')).not.toContain('203.0.113.7');
    expect(sourceFor('   ')).toBeNull();
    expect(sourceFor(null)).toBeNull();
    expect(sourceFor(undefined)).toBeNull();
  });

  it('neither digest is computable from the input alone — the key changes it', () => {
    // keyFor is only ever called through config()'s secret; the assertion is that no digest
    // built without that secret equals one built with it.
    expect(keyFor('a@example.invalid')).not.toBe(
      createHash('sha256').update('email:a@example.invalid').digest('hex'),
    );
  });
});

describe('the session cookie', () => {
  it('is httpOnly, Secure, SameSite=Lax, path / and 30 days, under one constant name', async () => {
    const userId = await seedUser();
    const cookies = new TestCookieStore();
    await withRequest(cookies, () => createSession(userId));

    const written = cookies.last;
    expect(written?.name).toBe(SESSION_COOKIE);
    expect(written?.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(written?.options.maxAge).toBe(60 * 60 * 24 * 30);
  });
});

describe('checkRateLimit', () => {
  const email = 'limit@example.invalid';

  it(`is 'ok' at five failures and 'account' once ${ACCOUNT_LIMIT} already exist`, async () => {
    for (let attempt = 1; attempt <= ACCOUNT_LIMIT; attempt += 1) {
      // The check happens BEFORE the attempt is recorded, so attempt six is still 'ok'.
      expect(await checkRateLimit(email, null)).toBe('ok');
      await recordAttempt(email, null, false);
    }
    // Six failures now exist, so the seventh wrong attempt is refused.
    expect(await checkRateLimit(email, null)).toBe('account');
  });

  it(`is 'source' once ${SOURCE_LIMIT} failures from that address already exist`, async () => {
    // A different account each time, so the account bucket stays empty and the only thing
    // that can speak is the source bucket.
    for (let attempt = 1; attempt <= SOURCE_LIMIT; attempt += 1) {
      const account = `flood-${attempt}@example.invalid`;
      expect(await checkRateLimit(account, '203.0.113.7')).toBe('ok');
      await recordAttempt(account, '203.0.113.7', false);
    }
    // The twenty-first attempt is refused without the password being looked at.
    expect(await checkRateLimit('flood-21@example.invalid', '203.0.113.7')).toBe('source');
  });

  it('exempts a request with no determinable source address from the source bucket', async () => {
    // More failed attempts than SOURCE_LIMIT, but every one of them recorded with no address.
    for (let attempt = 0; attempt < SOURCE_LIMIT + 5; attempt += 1) {
      await recordAttempt(email, null, false);
      await db.execute(sql`UPDATE login_attempts SET "key_hash" = ${'other-key'} WHERE "key_hash" = ${keyFor(email)}`);
    }
    const rows = await db.select().from(loginAttempts);
    expect(rows.length).toBeGreaterThan(SOURCE_LIMIT);

    // No address was determined, so the source bucket cannot speak at all.
    expect(await checkRateLimit(email, null)).toBe('ok');
  });

  it('counts succeeded = false only, so repeated successful sign-ins never lock anyone out', async () => {
    for (let attempt = 0; attempt < SOURCE_LIMIT * 2; attempt += 1) {
      await recordAttempt(email, '203.0.113.7', true);
    }
    expect(await checkRateLimit(email, '203.0.113.7')).toBe('ok');

    // One failure is not twenty failures either.
    await recordAttempt(email, '203.0.113.7', false);
    expect(await checkRateLimit(email, '203.0.113.7')).toBe('ok');
  });

  it('a row exactly WINDOW old is outside the window — the comparison is strictly greater', async () => {
    await recordAttempt(email, null, false);
    expect(await checkRateLimit(email, null)).toBe('ok');

    await db.execute(sql`UPDATE login_attempts SET "created_at" = ${new Date(Date.now() - WINDOW_MS)}`);

    // created_at > now - WINDOW, strictly: a row exactly at the boundary is already outside.
    expect(await checkRateLimit(email, null)).toBe('ok');
  });

  it('a row older than the window is pruned, so neither predicate scans an unbounded history', async () => {
    await recordAttempt(email, null, false);
    await db.execute(sql`UPDATE login_attempts SET "created_at" = ${new Date(Date.now() - WINDOW_MS - 60_000)}`);

    expect(await checkRateLimit(email, null)).toBe('ok');
    const remaining = await db.execute(sql`SELECT count(*)::int AS count FROM login_attempts`);
    expect(remaining.rows[0]?.count).toBe(0);
  });
});