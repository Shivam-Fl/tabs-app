import { Skeleton } from '@/components/ui';

/**
 * The balances screen's loading state: the header and back link, rows at member-row height, and
 * three transfer rows (docs/ui.md, Balances · loading) — three because that is what a small
 * group's settlement usually comes to, and a skeleton is a shape, not a promise.
 *
 * The static skeleton the pattern asks for — no spinner, no shimmer — and the same shape the
 * members screen uses, because both are lists of rows with a name on the left and a right-hand
 * figure.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-space-6" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-space-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="flex flex-col">
        <Skeleton className="h-[52px] w-full" />
        <Skeleton className="h-[52px] w-full" />
        <Skeleton className="h-[52px] w-full" />
      </div>
      <div className="flex flex-col">
        <Skeleton className="h-[76px] w-full" />
        <Skeleton className="h-[76px] w-full" />
        <Skeleton className="h-[76px] w-full" />
      </div>
    </div>
  );
}
