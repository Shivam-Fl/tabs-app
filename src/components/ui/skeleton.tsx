/**
 * A static block in the shape of what is coming. No shimmer, and therefore nothing to disable
 * under prefers-reduced-motion.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`rounded-radius bg-surface ${className}`} />;
}