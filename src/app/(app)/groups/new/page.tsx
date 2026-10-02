import type { Metadata } from 'next';

import { CreateGroupForm } from '@/components/create-group-form';
import { requireUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'New group · Tabs' };

/**
 * The create-group screen. requireUser() also runs in the layout; it runs again here because
 * the form is seeded from the caller's own default currency, which the layout does not pass on.
 */
export default async function NewGroupPage() {
  const user = await requireUser();

  return (
    <div className="flex flex-col gap-space-6">
      <h1>New group</h1>
      <CreateGroupForm defaultCurrency={user.defaultCurrency} />
    </div>
  );
}
