import type { ReactNode } from 'react';

/**
 * Two kinds, and they are never confused: no data yet (a sentence plus the single action
 * that creates the first one) and no results (what was filtered, plus a way to clear it).
 *
 * `headingLevel` is a prop so the caller says whether this block owns the screen's h1 —
 * exactly-one-h1 is the caller's decision, not an accident of nesting.
 */
export function EmptyState({
  title,
  description,
  action,
  kind = 'no-data',
  headingLevel = 'h2',
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  kind?: 'no-data' | 'no-results';
  headingLevel?: 'h1' | 'h2' | 'h3';
}) {
  const Heading = headingLevel;
  return (
    <div className="flex flex-col items-start gap-space-3 py-space-6">
      <Heading className={headingLevel === 'h1' ? 'text-2xl' : headingLevel === 'h2' ? 'text-xl' : 'text-lg'}>
        {title}
      </Heading>
      {description ? <p className="text-base text-text-muted">{description}</p> : null}
      {kind === 'no-results' ? <p className="text-sm text-text-muted">Clear the filters to see everything.</p> : null}
      {action}
    </div>
  );
}