import { Skeleton } from '@/components/ui';

/**
 * The expenses list's loading state: the header, the back link, and five rows at list-row
 * height, in the shape of a real row so nothing jumps when the rows land (docs/ui.md,
 * Expenses · loading).
 *
 * The static skeleton the pattern asks for — no spinner, no shimmer — and the same shape the
 * members screen uses, because both are lists of rows with a name on the left and a right-hand
 * column.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-space-6" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-space-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="flex flex-col">
        <Skeleton className="h-[76px] w-full" />
        <Skeleton className="h-[76px] w-full" />
        <Skeleton className="h-[76px] w-full" />
        <Skeleton className="h-[76px] w-full" />
        <Skeleton className="h-[76px] w-full" />
      </div>
    </div>
  );
}
