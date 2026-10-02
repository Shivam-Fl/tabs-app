import { Skeleton } from '@/components/ui';

/**
 * The edit screen's loading state, and the piece docs/ui.md's Expense form · loading is about:
 * "For edit only, a skeleton of the populated form so the layout does not jump when it lands."
 *
 * Form-shaped rather than list-shaped on purpose. Without this file the segment would inherit
 * ../loading.tsx and flash five expense rows where a form is about to appear — a skeleton in the
 * wrong shape is worse than none.
 *
 * The blocks are the form's own: the header, the amount row with its fixed currency symbol, the
 * three single-line fields, the two multi-line blocks, the payer rows, the split control, the
 * picker rows, the summary line and the action.
 */
export default function Loading() {
  return (
    <div className="flex max-w-[420px] flex-col gap-space-6" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-space-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="flex flex-col gap-space-4">
        <div className="flex items-end gap-space-2">
          <Skeleton className="h-6 w-6" />
          <Skeleton className="h-11 flex-1" />
        </div>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-11 w-full" />
      </div>
    </div>
  );
}
