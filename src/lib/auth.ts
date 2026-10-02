import { createHmac, randomBytes, scrypt, timingSafeEqual, createHash, type ScryptOptions } from 'node:crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';

import { database } from '@/db/client';
import { loginAttempts, sessions, users } from '@/db/schema';
import { config } from '@/lib/env';
import { cookieStore, clearSessionCookie, createSessionCookie, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from '@/lib/cookies';

/**
 * The whole of auth, so its security properties are readable in one file.
 *
 * It never imports next/headers directly: cookies go through src/lib/cookies.ts, which is
 * what makes a Server Action callable under vitest at all.
 */

export { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS };

export const SALT_BYTES = 16;
export const SCRYPT_N = 2 ** 17;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const KEY_LENGTH = 64;
export const SESSION_TOKEN_BYTES = 32;

/**
 * scrypt's working set is 128 * N * r bytes, which at these parameters is 128 MB. Node's
 * default maxmem is 32 MB, so without this every hash throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS
 * — the parameters are the point, so the ceiling is raised rather than the cost lowered.
 */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** Failed sign-ins in the sliding window. */
export const WINDOW_MS = 15 * 60 * 1000;
export const ACCOUNT_LIMIT = 6;
export const SOURCE_LIMIT = 20;

export const GENERIC_AUTH_ERROR =
  'That email and password combination did not work. Check them and try again.';

export type RateLimitVerdict = 'ok' | 'account' | 'source';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  defaultCurrency: string;
}

// --- passwords ---------------------------------------------------------------------

/**
 * scrypt at N=2^17, r=8, p=1 with a 16-byte random salt. OWASP ranks scrypt immediately
 * behind Argon2id and Node ships it in crypto, so a slow salted hash costs no dependency and
 * no install step — the one dependency class this CI cannot install safely.
 *
 * The ASYNC entry point, deliberately. These parameters cost about 360 ms of CPU, and
 * scryptSync spends that on the main thread of the one process serving every request: one
 * sign-in attempt stalls the health poll and everybody else's alongside it. crypto.scrypt
 * runs the same work on the thread pool, so the request is suspended rather than the server.
 *
 * Stored as `scrypt$N$r$p$salt$hash`, so the parameters travel with the hash and raising N
 * later does not invalidate the existing ones.
 */
const SCRYPT_OPTIONS: ScryptOptions = {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: SCRYPT_MAXMEM,
};

function deriveKey(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await deriveKey(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, salt, digest] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(digest, 'base64');
  let derived: Buffer;
  try {
    derived = await deriveKey(password, Buffer.from(salt, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// --- keyed digests -----------------------------------------------------------------

/**
 * HMAC-SHA-256, not a plain digest. The session token has 2^256 of entropy so SHA-256 is
 * enough for it, but an email address is low-entropy and any wordlist reverses it, and the
 * IPv4 space is exhaustible in minutes. Both of those are keyed, which means no digest for
 * either is computable without the secret in src/lib/env.ts.
 */
function hmac(value: string): string {
  return createHmac('sha256', config().hmacKey).update(value).digest('hex');
}

/** The rate-limit key for an email: trimmed, lowercased, then keyed. */
export function keyFor(email: string): string {
  return hmac(`email:${email.trim().toLowerCase()}`);
}

/** The rate-limit key for a source address, or null when none could be determined. */
export function sourceFor(address: string | null | undefined): string | null {
  const trimmed = address?.trim();
  return trimmed ? hmac(`source:${trimmed}`) : null;
}

/** The digest a session row stores. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// --- sessions ----------------------------------------------------------------------

/** A new random token. Only its SHA-256 is persisted; the raw value goes in the cookie. */
export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export async function createSession(userId: string): Promise<string> {
  const db = await database();
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  await createSessionCookie(token);
  return token;
}

/** The user, only if the row exists and has not expired. An expired row it touches is deleted. */
export async function resolveSession(token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const db = await database();
  const tokenHash = hashToken(token);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      defaultCurrency: users.defaultCurrency,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }

  const { id, email, displayName, defaultCurrency } = row;
  return { id, email, displayName, defaultCurrency };
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  const db = await database();
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

// --- sign-in rate limiting ----------------------------------------------------------

/**
 * Both boundaries, stated once each, in terms of an attempt.
 *
 * ACCOUNT: refuses a wrong password once six failures for that key already exist in the
 * window, so the seventh wrong attempt inside the window is refused — and a correct password
 * is accepted regardless of the count. It saves no CPU: verifying is what costs anything, and
 * a correct password still has to be verified to be accepted.
 *
 * SOURCE: refuses once twenty failures from that source already exist in the window, so the
 * twenty-first attempt inside the window is refused without verifying the password at all.
 * This is the limit that saves work, because flooding is a denial of service rather than a
 * credential guess.
 *
 * Both count `succeeded = false` only. TR-11's subject is failed sign-ins; counting a
 * success would refuse a correct password for having signed in twenty times in fifteen
 * minutes, a lockout the requirement does not ask for.
 *
 * When no address can be determined the source limit does not apply and the account limit
 * carries the request alone: `next start` on loopback sets neither x-forwarded-for nor
 * x-real-ip, so a shared bucket would let one flood refuse every legitimate user.
 */
export async function checkRateLimit(email: string, address?: string | null): Promise<RateLimitVerdict> {
  const db = await database();
  const keyHash = keyFor(email);
  const sourceHash = sourceFor(address);

  // Retention. Every attempt writes a row by design, so old rows are pruned here rather than
  // accumulating until a query has to skip them. Index-supported.
  const cutoff = new Date(Date.now() - WINDOW_MS);
  await db.delete(loginAttempts).where(lt(loginAttempts.createdAt, cutoff));

  if (sourceHash) {
    const fromSource = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.sourceHash, sourceHash),
          eq(loginAttempts.succeeded, false),
          gt(loginAttempts.createdAt, cutoff),
        ),
      );
    if ((fromSource[0]?.count ?? 0) >= SOURCE_LIMIT) return 'source';
  }

  const forKey = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(eq(loginAttempts.keyHash, keyHash), eq(loginAttempts.succeeded, false), gt(loginAttempts.createdAt, cutoff)),
    );
  return (forKey[0]?.count ?? 0) >= ACCOUNT_LIMIT ? 'account' : 'ok';
}

/** Records one attempt, with its true outcome. */
export async function recordAttempt(email: string, address: string | null | undefined, succeeded: boolean): Promise<void> {
  const db = await database();
  await db.insert(loginAttempts).values({
    keyHash: keyFor(email),
    sourceHash: sourceFor(address) ?? '',
    succeeded,
  });
}

/** A successful sign-in clears the account's failure rows so the bucket is not left polluted. */
export async function clearFailures(email: string): Promise<void> {
  const db = await database();
  await db
    .delete(loginAttempts)
    .where(and(eq(loginAttempts.keyHash, keyFor(email)), eq(loginAttempts.succeeded, false)));
}

// --- the request-scoped session ----------------------------------------------------

/**
 * The signed-in user, or a redirect to sign-in. Every page inside the (app) route group and
 * every Server Action that writes to somebody's own data calls this, so authorisation is
 * something the shell does once rather than something each call site remembers.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/sign-in');
  return user;
}

export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookieStore();
  return resolveSession(store.get(SESSION_COOKIE)?.value ?? '');
}

export async function signOutAndClearCookie(): Promise<void> {
  const store = await cookieStore();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  await clearSessionCookie();
}