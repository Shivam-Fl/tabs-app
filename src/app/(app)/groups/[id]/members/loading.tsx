import { Skeleton } from '@/components/ui';

/**
 * The members screen's loading state: the header, the back link, five member rows, and the
 * invite block.
 *
 * The invite block is skeletoned with everything else because the token arrives with the rest
 * of the data: without this the block would render as "no link" for a moment and then fill in,
 * which reads as the link having been turned off. A skeleton says "not yet" instead.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-space-6" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-space-2">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-8 w-40" />
      </div>
      <div className="flex flex-col gap-space-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
      <div className="flex flex-col gap-space-2">
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-12 w-full sm:max-w-[360px]" />
        <Skeleton className="h-11 w-32" />
      </div>
    </div>
  );
}
