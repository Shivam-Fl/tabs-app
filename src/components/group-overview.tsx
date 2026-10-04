import Link from 'next/link';

import type { ActivityRow, GroupRow } from '@/lib/access';
import { SETTLED_MESSAGE, type NamedBalance, type Transfer } from '@/lib/balances';
import { formatMinor } from '@/lib/money';
import { LinkButton, Money, directionOf } from '@/components/ui';

/**
 * The group overview's body.
 *
 * Synchronous and presentational, for the reason Shell and HomeEmpty are: the page that renders
 * it is an async Server Component awaiting cookies(), which @testing-library/react cannot
 * render, so extracting the markup is what lets a component test assert this screen's one h1
 * and its exact empty-state strings.
 *
 * Balances are formatted here and never computed here: every figure comes from formatMinor over
 * a bigint, and the direction is words beside the number rather than a sign or a colour.
 */
export function GroupOverview({
  group,
  members,
  transfers,
  entries,
}: {
  group: GroupRow;
  /** Every active member with their net, from the same read the balances screen uses. */
  members: NamedBalance[];
  /** The fewest transfers that settle those nets. Empty when everybody is square. */
  transfers: Transfer[];
  entries: ActivityRow[];
}) {
  const nameOf = new Map(members.map((member) => [member.memberId, member.displayName]));
  return (
    <div className="flex flex-col gap-space-6">
      <header className="flex flex-col gap-space-1">
        <Link href="/" className="inline-flex min-h-[44px] items-center text-base text-text-muted">
          ← Your groups
        </Link>
        <h1>{group.name}</h1>
        <p className="text-sm text-text-muted">
          {group.type} · {group.currency}
        </p>
        {group.archivedAt ? (
          <p role="status" className="text-base text-text-muted">
            This group is archived.
          </p>
        ) : null}
      </header>

      <section className="flex flex-col gap-space-2">
        <h2 className="text-xl">Balances</h2>
        <ul className="flex flex-col">
          {members.map((member) => (
            <li
              key={member.memberId}
              className="flex min-h-[44px] items-center justify-between gap-space-3 border-b border-border py-space-3 last:border-b-0"
            >
              <span className="truncate">{member.displayName}</span>
              {/* The direction is read off the figure rather than assumed: a zero here was a
                  literal until this piece, and the whole point of the screen is that it is not. */}
              <Money
                formatted={formatMinor(member.balanceMinor, group.currency)}
                direction={directionOf(member.balanceMinor)}
                voice="person"
              />
            </li>
          ))}
        </ul>
        {/* docs/ui.md's simplified-debts block. When there is nothing to settle the block says
            so instead of listing nothing (TR-9) — the sentence verbatim from docs/ui.md line
            165, with an ASCII apostrophe: U+2019 fails CI rather than passing here and reading
            wrong. The same constant the balances screen renders, so the two cannot drift. */}
        {transfers.length === 0 ? (
          <p className="text-base text-text-muted">{SETTLED_MESSAGE}</p>
        ) : (
          <ul className="flex flex-col">
            {transfers.map((transfer) => (
              <li
                key={`${transfer.fromMemberId}-${transfer.toMemberId}`}
                className="flex min-h-[44px] items-center justify-between gap-space-3 border-b border-border py-space-3 last:border-b-0"
              >
                <span className="truncate">
                  {nameOf.get(transfer.fromMemberId) ?? 'A member'} pays{' '}
                  {nameOf.get(transfer.toMemberId) ?? 'a member'}
                </span>
                <span className="shrink-0 font-mono tabular-nums">
                  {formatMinor(transfer.amountMinor, group.currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-space-2">
        <h2 className="text-xl">Recent activity</h2>
        {entries.length === 0 ? (
          // docs/ui.md line 123, and issue #4's IAC-2, word for word — the em dash is U+2014.
          <p className="text-base text-text-muted">Nothing here yet — add the first expense.</p>
        ) : (
          <ul className="flex flex-col">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex min-h-[44px] items-center justify-between gap-space-3 border-b border-border py-space-3 last:border-b-0"
              >
                <span className="truncate">{describe(entry)}</span>
                <span className="shrink-0 text-sm text-text-muted">
                  {entry.createdAt.toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* docs/ui.md's secondary action row: Add expense is the primary action and the rest are
          links. Activity joins them with its own screen in #10; the Expenses link is here
          because the list is otherwise reachable only through the form. */}
      <nav aria-label="Group" className="flex flex-wrap gap-space-2">
        <LinkButton href={`/groups/${group.id}/expenses/new`}>Add expense</LinkButton>
        <Link
          href={`/groups/${group.id}/balances`}
          className="inline-flex min-h-[44px] items-center rounded-radius border border-border bg-surface px-space-4 font-medium"
        >
          Balances
        </Link>
        <Link
          href={`/groups/${group.id}/expenses`}
          className="inline-flex min-h-[44px] items-center rounded-radius border border-border bg-surface px-space-4 font-medium"
        >
          Expenses
        </Link>
        <Link
          href={`/groups/${group.id}/members`}
          className="inline-flex min-h-[44px] items-center rounded-radius border border-border bg-surface px-space-4 font-medium"
        >
          Members
        </Link>
      </nav>
    </div>
  );
}

/**
 * One feed entry in a sentence. The Record is exhaustive over ActivityKind on purpose: adding a
 * kind without a sentence for it is a compile error, not a row that renders as "undefined".
 *
 * The four invite and placeholder kinds are described even though the overview's recent block
 * filters the group.* ones out — a member.placeholder_added and a member.claimed do reach it,
 * and an entry the reader cannot parse is worse than no feed.
 */
function describe(entry: ActivityRow): string {
  const who = entry.actorName ?? 'Somebody';
  const what: Record<ActivityRow['kind'], string> = {
    'group.created': 'created the group',
    'group.renamed': 'renamed the group',
    'group.archived': 'archived the group',
    'group.invite_rotated': 'made a new invite link',
    'group.invite_disabled': 'turned the invite link off',
    'member.joined': 'joined the group',
    'member.left': 'left the group',
    'member.removed': 'was removed from the group',
    'member.placeholder_added': 'was added to the group by name',
    'member.claimed': 'claimed their place in the group',
    // The subject and detail the entry carries are not rendered here: the feed screens of #8
    // read them. Until then this line says what happened without repeating the amount, which
    // the overview does not otherwise show for an expense. An edit whose detail is empty says
    // "edited an expense" and nothing more, which is exactly what was recorded.
    'expense.added': 'added an expense',
    'expense.edited': 'edited an expense',
    'expense.deleted': 'deleted an expense',
  };
  return `${who} ${what[entry.kind]}`;
}
