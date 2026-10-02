import { Skeleton } from '@/components/ui';

/**
 * The loading skeleton for the signed-in group: three group rows.
 *
 * The two figure placeholders are gone with piece 2. They stood for a summary of what the reader
 * owes across their groups, which is piece 6's computation — a placeholder for a figure nobody
 * can compute yet is a promise the screen cannot keep, and the "you owe / you are owed" pair is
 * the one place docs/ui.md forbids a zero standing in, because a zero reads as "you owe
 * nothing" rather than "not known yet".
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-space-6" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-space-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}
