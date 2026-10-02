import { LinkButton } from '@/components/ui';

/**
 * What a non-member sees for a group they are not in — and what every later notFound() inside
 * this route group inherits until it brings its own copy.
 *
 * It never names the group. The id is in the URL and the reader typed it or was sent it, so
 * echoing a name back would confirm the existence of a group they may not know about, which is
 * the whole thing TR-1's 404 is protecting.
 */
export default function NotFound() {
  return (
    <div className="flex flex-col items-start gap-space-4">
      <h1>This group isn&apos;t available.</h1>
      <p className="text-base text-text-muted">
        It may have been archived, or you may not be a member of it.
      </p>
      <LinkButton href="/" variant="secondary">
        Back to your groups
      </LinkButton>
    </div>
  );
}
