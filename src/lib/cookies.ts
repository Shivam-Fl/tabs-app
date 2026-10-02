import { AsyncLocalStorage } from 'node:async_hooks';
import { cookies, headers } from 'next/headers';

/**
 * The one named seam between the product and a test.
 *
 * This is the ONLY module in src/ that imports next/headers. `cookies()` throws outside a
 * request scope, so a Server Action cannot be called directly under vitest and a test cannot
 * assert the session cookie's attributes. Routing every read and write through here is what
 * makes AC-5, AC-6, AC-7 and AC-11 testable at all.
 *
 * It also owns the cookie's name and lifetime, so the two writers below and every test
 * cannot disagree about either. auth.ts re-exports both.
 */

export const SESSION_COOKIE = 'tabs_session';

/** 30 days, the maxAge TR-10 asks for. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  path?: string;
  maxAge?: number;
}

export interface CookieRecord {
  name: string;
  value: string;
  options: CookieOptions;
}

/** What a test installs in place of next/headers' request-scoped cookies. */
export interface CookieReaderWriter {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: CookieOptions): void;
  delete(name: string): void;
}

/**
 * Everything a Server Action can learn about the request it is serving. Cookies and headers
 * live together because they share one question — is there a request scope — and answering
 * it in one place is what keeps next/headers out of every other module.
 */
export interface RequestScope {
  cookies: CookieReaderWriter;
  headers: Headers;
}

const asyncLocalStore = new AsyncLocalStorage<RequestScope>();

/**
 * The cookies of the current request, or the jar a test has installed.
 */
export async function cookieStore(): Promise<CookieReaderWriter> {
  const scope = asyncLocalStore.getStore();
  if (scope) return scope.cookies;
  return await cookies();
}

/**
 * The headers of the current request. A Server Action has no Headers argument, so the source
 * address the per-source rate limit keys on can only come from here.
 */
export async function requestHeaders(): Promise<Headers> {
  const scope = asyncLocalStore.getStore();
  if (scope) return scope.headers;
  return await headers();
}

/** Installs a scope for the duration of `run`. This is the test's half of the seam. */
export function withRequestScope<T>(scope: RequestScope, run: () => T): T {
  return asyncLocalStore.run(scope, run);
}

/**
 * The session cookie. httpOnly, Secure, SameSite=Lax, path /, 30 days — unconditionally.
 * Chrome and Firefox both treat http://localhost as a secure context and store a Secure
 * cookie there, so TR-10 holds in QA as written. Omitting Secure in development is not an
 * option the product has.
 */
export async function createSessionCookie(token: string): Promise<void> {
  const store = await cookieStore();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookieStore();
  store.delete(SESSION_COOKIE);
}