import { Button } from './button';

/**
 * One sentence, one action, and never a raw error, a stack trace or an error code. A failed
 * page load is never a dead end, so Try again is not optional — docs/ui.md requires exactly
 * one action here, and both callers (the route group's error boundary and every later screen)
 * have one to give.
 */
export function ErrorState({
  message,
  onRetry,
  headingLevel = 'h2',
}: {
  message: string;
  onRetry: () => void;
  headingLevel?: 'h1' | 'h2' | 'h3';
}) {
  const Heading = headingLevel;
  return (
    <div role="alert" className="flex flex-col items-start gap-space-3 py-space-6">
      <Heading className="text-lg">{message}</Heading>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
