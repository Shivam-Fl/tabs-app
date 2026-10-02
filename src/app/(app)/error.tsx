'use client';

import { ErrorState } from '@/components/ui';

/**
 * The error boundary for every signed-in screen. Next requires a Client Component here.
 *
 * docs/ui.md's error pattern is that a page is never a dead end, which is only true if a
 * boundary exists: one sentence saying what failed, whatever did load still on screen, and a
 * Try again. No raw error, no stack trace, no error code.
 */
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState message="Couldn't load this page." onRetry={reset} />;
}
