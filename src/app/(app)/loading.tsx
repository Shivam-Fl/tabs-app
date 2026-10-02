import { Skeleton } from '@/components/ui';

/**
 * The loading skeleton for the signed-in group: two figure placeholders and three group rows.
 *
 * The figures are placeholders and not zeros — a zero reads as "you owe nothing", which is a
 * different and wrong answer.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-space-6" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="flex gap-space-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="flex flex-col gap-space-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}
