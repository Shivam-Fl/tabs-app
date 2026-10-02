'use server';

import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { database, insertUser } from '@/db/client';
import { users } from '@/db/schema';
import { trustedProxyCount } from '@/lib/env';
import {
  GENERIC_AUTH_ERROR,
  checkRateLimit,
  clearFailures,
  createSession,
  hashPassword,
  recordAttempt,
  revokeSession,
  verifyPassword,
} from '@/lib/auth';
import { SESSION_COOKIE, clearSessionCookie, cookieStore, requestHeaders } from '@/lib/cookies';

/**
 * Sign-up, sign-in and sign-out.
 *
 * Every expected failure returns the same typed shape rather than throwing: the form renders
 * it, and a thrown error would be a dead end with nothing on screen. Only signOut redirects,
 * because only signOut is submitted by a plain <form action>; sign-in and sign-up go through
 * useActionState and navigate from the returned redirectTo, which is also what lets a test
 * read the result instead of catching NEXT_REDIRECT.
 */

export interface AuthFieldErrors {
  [field: string]: string;
}

export interface AuthResult {
  ok: boolean;
  fieldErrors?: AuthFieldErrors;
  formError?: string;
  /** Set only on success. */
  redirectTo?: string;
}

/**
 * Bounds that are not decoration. keyFor HMACs the whole email and the column is unbounded
 * text; scrypt runs over the whole password, so an unbounded body would spend the third of a
 * second per attempt the source limiter exists to ration.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .email('Enter a valid email address.');

const passwordSchema = z.string().min(8, 'Use at least 8 characters.').max(200, 'That password is too long.');

const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name to show to your groups.')
  .max(80, 'That name is too long.');

const signUpSchema = z.object({ displayName: displayNameSchema, email: emailSchema, password: passwordSchema });

const signInSchema = z.object({ email: emailSchema, password: z.string().min(1, 'Enter your password.') });

function fieldErrorsFrom(error: z.ZodError): AuthFieldErrors {
  const errors: AuthFieldErrors = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? 'form');
    errors[field] ??= issue.message;
  }
  return errors;
}

/**
 * A hash to spend the same scrypt work on when no account matches, so an unknown email is
 * not faster than a wrong password and the response time carries no hint that the account
 * does not exist. Derived once per process from a random password nobody holds.
 */
let decoyHash: Promise<string> | undefined;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword(`decoy-${Math.random().toString(36).slice(2)}`);
  return decoyHash;
}

/**
 * The address the request came from, or null.
 *
 * Headers are the only evidence a Server Action has of it — it takes no Headers argument — and
 * they are also the least trustworthy thing in the request. `x-forwarded-for` is a plain
 * header: a caller can send any value, including the first entry, which is the one a naive
 * reading takes. Keying a security control on that lets one flood buy a fresh empty bucket per
 * request, which is the limit refusing to limit.
 *
 * So nothing in the header is trusted until an operator declares how many proxies append to
 * it. With TABS_TRUSTED_PROXIES=n the address is the n-th entry from the right — the one the
 * nearest trusted hop saw — and a chain shorter than n means no trusted hop appended, so
 * there is nothing to trust. Unset — the default, and every local and CI boot — therefore
 * leaves the address undetermined.
 *
 * That is the weaker failure on purpose: the source bucket does not apply, rather than
 * applying to whatever the caller last typed. AC-7's exemption for an undetermined address is
 * what a deployment without a declared proxy gets, and the account limit still speaks.
 */
function sourceAddressOf(headers: Headers): string | null {
  const trusted = trustedProxyCount();
  if (trusted < 1) return null;

  const chain = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (chain.length >= trusted) return chain[chain.length - trusted] ?? null;

  // A proxy that REPLACES the header rather than appending to it leaves no chain to walk.
  return headers.get('x-real-ip')?.trim() || null;
}

export async function signUp(_previous: AuthResult | null, formData: FormData): Promise<AuthResult> {
  const parsed = signUpSchema.safeParse({
    displayName: formData.get('displayName'),
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const { displayName, email, password } = parsed.data;
  const db = await database();

  // A nicety, for the message only. The insert below is the guarantee: a read-then-insert is
  // a race, and the unique constraint is what actually stops the double submit QA performs.
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    return { ok: false, fieldErrors: { email: 'An account with that email already exists.' } };
  }

  const passwordHash = await hashPassword(password);

  // One statement, so one statement's atomicity: there is no read and write here to make
  // atomic together. What decides a duplicate is the unique constraint, and this is the
  // insert that asks it.
  const createdId = await insertUser(db, { email, passwordHash, displayName, defaultCurrency: 'USD' });

  if (!createdId) {
    // The concurrent case: the other request won the unique constraint.
    return { ok: false, fieldErrors: { email: 'An account with that email already exists.' } };
  }

  await createSession(createdId);
  return { ok: true, redirectTo: '/' };
}

/**
 * The order below is the whole of TR-11's rate limiting, and it is this order and no other:
 *
 *   1. prune rows older than the window (checkRateLimit does this at its top)
 *   2. if an address was determined and its bucket is already at twenty failures, refuse
 *      with the generic message having skipped the password comparison entirely
 *   3. otherwise verify the password — ALWAYS, because a correct password is accepted however
 *      many failures precede it
 *   4. on success write a row with succeeded = true, clear the account's failure rows and
 *      create the session; on failure record a row unless the account bucket is already at
 *      ACCOUNT_LIMIT, in which case no seventh row is written
 *
 * All four refusals — unknown email, wrong password, account-limited, source-limited —
 * return the identical result object and therefore the identical rendered message.
 */
export async function signIn(_previous: AuthResult | null, formData: FormData): Promise<AuthResult> {
  const parsed = signInSchema.safeParse({ email: formData.get('email'), password: formData.get('password') });
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrorsFrom(parsed.error) };

  const { email, password } = parsed.data;
  const db = await database();

  // Null means no address could be determined, which is what happens on every loopback boot:
  // nothing there declares a trusted proxy, and the source bucket must not become a bucket
  // shared by every visitor of a deployment.
  const address = sourceAddressOf(await requestHeaders());

  const verdict = await checkRateLimit(email, address);

  if (verdict === 'source') {
    return { ok: false, formError: GENERIC_AUTH_ERROR };
  }

  const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  const valid = await verifyPassword(password, user ? user.passwordHash : await decoy());

  if (!valid || !user) {
    // Already at the limit, so the seventh wrong attempt inside the window records nothing
    // and returns exactly what the first six returned.
    if (verdict !== 'account') await recordAttempt(email, address, false);
    return { ok: false, formError: GENERIC_AUTH_ERROR };
  }

  await recordAttempt(email, address, true);
  await clearFailures(email);
  await createSession(user.id);
  return { ok: true, redirectTo: '/' };
}

export async function signOut(): Promise<void> {
  const store = await cookieStore();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  await clearSessionCookie();
  redirect('/sign-in');
}