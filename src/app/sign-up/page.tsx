import type { Metadata } from 'next';

import { AuthForm } from '@/components/auth-form';

export const metadata: Metadata = { title: 'Create your account · Tabs' };

/** The same centred card for display name, email and password. */
export default async function SignUpPage({
  searchParams,
}: {
  /** Mirrors sign-in: an invite link sends a new person here, and the destination they came
   *  for has to survive the account they create on the way. */
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;

  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-bg p-space-6">
      <AuthForm mode="sign-up" next={typeof next === 'string' ? next : undefined} />
    </main>
  );
}
