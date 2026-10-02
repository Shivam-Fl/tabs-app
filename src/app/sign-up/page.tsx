import type { Metadata } from 'next';

import { AuthForm } from '@/components/auth-form';

export const metadata: Metadata = { title: 'Create your account · Tabs' };

/** The same centred card for display name, email and password. */
export default function SignUpPage() {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-bg p-space-6">
      <AuthForm mode="sign-up" />
    </main>
  );
}
