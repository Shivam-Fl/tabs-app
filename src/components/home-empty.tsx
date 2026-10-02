import { LinkButton } from '@/components/ui';

/**
 * The home empty state, docs/ui.md's words verbatim. This is the most important empty state
 * in the product: it is where a new user arrives.
 *
 * Synchronous and presentational, for the same reason as the shell — the page that renders it
 * cannot be imported by a test, because importing it would construct a real database.
 *
 * There are no groups yet and no group table, so this renders no query at all. "Create group"
 * links to a screen piece 2 builds; the ticket's own wording requires the action to be here.
 */
export function HomeEmpty() {
  return (
    <div className="flex flex-col items-start gap-space-4">
      <h1>You&apos;re not in any groups yet.</h1>
      <LinkButton href="/groups/new" size="lg">
        Create group
      </LinkButton>
      <p className="text-base text-text-muted">
        Got an invite link? Open it and the group will show up here.
      </p>
    </div>
  );
}