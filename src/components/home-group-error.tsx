'use client';

import { useRouter } from 'next/navigation';

import { ErrorState } from '@/components/ui';

/**
 * One group's row on the home screen when that group's balances could not be read (docs/ui.md,
 * Home · partial): the summary and the other groups render, and this row says what failed and
 * offers Try again, so one broken group does not cost the caller the other nine.
 *
 * A Client Component because Try again is a callback, and a Server Component cannot hand one
 * down. `router.refresh()` re-renders the server tree the row came from, which is the retry the
 * row actually wants — the alternative, refetching one group into a client-side store, would
 * give the summary a second source for the same number.
 */
export function HomeGroupError() {
  const router = useRouter();
  return (
    <ErrorState
      message="Couldn't load this group's balances."
      headingLevel="h3"
      onRetry={() => router.refresh()}
    />
  );
}
