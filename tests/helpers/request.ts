import { vi } from 'vitest';

import { withRequestScope } from '@/lib/cookies';
import type { CookieOptions, CookieRecord, CookieReaderWriter } from '@/lib/cookies';

/**
 * The other half of the cookies seam, plus a redirect capture.
 *
 * `cookies()` throws outside a request scope and `redirect()` throws NEXT_REDIRECT, so a
 * Server Action called directly would otherwise return nothing at all: no status, no cookie,
 * no target. This installs both, which is the boundary AC-5, AC-6 and AC-7 assert through.
 *
 * Import it before the action or route module it prepares for.
 */

/** Where a redirect() went, instead of NEXT_REDIRECT escaping into the test. */
export const redirects: string[] = [];

vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    redirects.push(target);
    throw new Error(`NEXT_REDIRECT:${target}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

/**
 * The same for revalidatePath. Outside a request there is no static generation store, and the
 * call is a cache invalidation rather than part of the write — the assertion belongs on the
 * row the write produced.
 */
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: <T,>(fn: T) => fn,
}));

/** An in-memory cookie jar, shaped like what next/headers exposes to a Server Action. */
export class TestCookieStore implements CookieReaderWriter {
  readonly written: CookieRecord[] = [];
  private readonly jar = new Map<string, string>();

  get(name: string): { value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { value };
  }

  set(name: string, value: string, options: CookieOptions): void {
    this.jar.set(name, value);
    this.written.push({ name, value, options });
  }

  delete(name: string): void {
    this.jar.delete(name);
    this.written.push({ name, value: '', options: {} });
  }

  /** Puts a cookie in the jar without recording a write — for replaying a captured value. */
  seed(name: string, value: string): void {
    this.jar.set(name, value);
  }

  get last(): CookieRecord | undefined {
    return this.written.at(-1);
  }
}

/**
 * Runs `body` with a request scope installed in place of next/headers'. Every Server Action
 * call inside it sees the jar, and the headers it derives a source address from.
 */
export function withRequest<T>(
  cookies: TestCookieStore,
  body: () => Promise<T>,
  requestHeaders: Record<string, string> = {},
): Promise<T> {
  redirects.length = 0;
  return withRequestScope({ cookies, headers: new Headers(requestHeaders) }, body);
}

/** Runs `body` and returns the redirect target instead of letting NEXT_REDIRECT escape. */
export async function captureRedirect(body: () => Promise<unknown>): Promise<string | undefined> {
  redirects.length = 0;
  try {
    await body();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('NEXT_REDIRECT:')) {
      return error.message.slice('NEXT_REDIRECT:'.length);
    }
    throw error;
  }
  return undefined;
}

/** FormData from a plain object, the shape a Server Action receives from a <form>. */
export function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, value);
  return data;
}