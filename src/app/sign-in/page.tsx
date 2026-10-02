import type { Metadata } from 'next';

import { AuthForm } from '@/components/auth-form';

export const metadata: Metadata = { title: 'Sign in · Tabs' };

/**
 * One centred card, capped at 360px, with no site navigation beyond the brand name.
 *
 * It sits outside the (app) route group so a signed-out visitor never runs the shell, and it
 * renders for a signed-in visitor too — no redirect is added in this ticket, because the QA
 * script's double-submit step needs the sign-up form.
 */
export default async function SignInPage({
  searchParams,
}: {
  /** Async in this version of Next. `next` is forwarded raw and validated by the action, which
   *  is the only place it can be: a value the page checked would still arrive unvalidated in
   *  the POST body, so there would be two rules and the wrong one would be load-bearing. */
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;

  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-bg p-space-6">
      <AuthForm mode="sign-in" next={typeof next === 'string' ? next : undefined} />
    </main>
  );
}
