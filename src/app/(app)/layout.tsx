import type { ReactNode } from 'react';

import { Shell } from '@/components/shell';
import { requireUser } from '@/lib/auth';

/**
 * The signed-in shell. requireUser() runs once here for every page inside the group, rather
 * than being something each page has to remember to call.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return <Shell user={user}>{children}</Shell>;
}
