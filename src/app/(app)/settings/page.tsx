import type { Metadata } from 'next';

import { SettingsForm } from '@/components/settings-form';
import { requireUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Settings · Tabs' };

/** The signed-in person's own details: display name and default currency. */
export default async function SettingsPage() {
  const user = await requireUser();

  return (
    <div className="flex flex-col gap-space-4">
      <h1>Settings</h1>
      <SettingsForm displayName={user.displayName} defaultCurrency={user.defaultCurrency} />
    </div>
  );
}
