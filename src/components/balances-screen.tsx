import Link from 'next/link';

import type { GroupRow, PaymentRow } from '@/lib/access';
import { SETTLED_MESSAGE, type NamedBalance, type Transfer } from '@/lib/balances';
import { formatMinor } from '@/lib/money';
import { DeletePaymentButton } from '@/components/delete-payment-button';
import { PaymentForm } from '@/components/payment-form';
import { Card, Money, directionOf } from '@/components/ui';

/**
 * The balances screen's body. Presentational and synchronous, like GroupOverview and
 * MembersScreen, so a component test can render it with a known ledger and assert the exact
 * words the design document specifies.
 *
 * Nothing is computed here. The nets and the transfers arrive as bigints that
 * src/lib/balances.ts produced from stored rows, and this file formats them and chooses words:
 * no arithmetic, no re-derivation of a split, and no sign rendered as a minus.
 *
 * The transfer list is the answer and the table is the working (docs/ui.md, Balances ·
 * Regions), so the transfers get the raised surface and the larger type and the table stays a
 * plain list.
 */
export function BalancesScreen({
  group,
  members,
  transfers,
  payments,
  viewerMemberId,
  defaultFrom,
  defaultTo,
}: {
  group: GroupRow;
  /** Every active member, in canonical order, each with their net. */
  members: NamedBalance[];
  /** The fewest transfers that settle those nets. Empty when everybody is square. */
  transfers: Transfer[];
  /**
   * The group's recorded payments, newest first. Empty is the ordinary state of a group nobody
   * has settled anything in yet, and the section is then not rendered at all: the transfer list
   * is already the answer, and an empty heading under it is a region saying nothing (TR-9).
   */
  payments: PaymentRow[];
  /**
   * The caller's own membership row. A payment may be deleted by the two members it involves and
   * by nobody else (TR-7), so this is what decides which rows carry the control — and the server
   * decides it again, so a row rendered without one is a courtesy rather than the guard.
   */
  viewerMemberId: string;
  /** What the form's two selects open on; see PaymentForm. */
  defaultFrom?: string;
  defaultTo?: string;
}) {
  const nameOf = new Map(members.map((member) => [member.memberId, member.displayName]));
  const paymentLabel = (payment: PaymentRow) =>
    `${formatMinor(payment.amountMinor, group.currency)} from ${payment.fromName} to ${payment.toName}`;

  return (
    <div className="flex flex-col gap-space-6">
      <header className="flex flex-col gap-space-1">
        <Link
          href={`/groups/${group.id}`}
          className="inline-flex min-h-[44px] items-center text-base text-text-muted"
        >
          ← {group.name}
        </Link>
        <h1>Balances</h1>
        <p className="text-sm text-text-muted">{group.name}</p>
      </header>

      {/* One row per member with the amount right-aligned; below 480px the row is the whole
          table (docs/ui.md, Balances · Narrow) — a list of rows either way, so there is only
          one of them. */}
      <section className="flex flex-col gap-space-2">
        <h2 className="text-xl">Net balances</h2>
        <ul className="flex flex-col">
          {members.map((member) => (
            <li
              key={member.memberId}
              className="flex min-h-[44px] items-center justify-between gap-space-3 border-b border-border py-space-3 last:border-b-0"
            >
              <span className="truncate">{member.displayName}</span>
              <Money
                formatted={formatMinor(member.balanceMinor, group.currency)}
                direction={directionOf(member.balanceMinor)}
                voice="person"
              />
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-space-2">
        <h2 className="text-xl">Settle up</h2>
        <Card className="flex flex-col">
          {transfers.length === 0 ? (
            // TR-9: a group where everybody is square says so, rather than rendering a zero
            // transfer. The sentence is docs/ui.md line 165, rendered from the constant the
            // overview renders so the two screens cannot drift.
            <p className="text-base text-text-muted">{SETTLED_MESSAGE}</p>
          ) : (
            <ul className="flex flex-col">
              {transfers.map((transfer) => (
                <li
                  key={`${transfer.fromMemberId}-${transfer.toMemberId}`}
                  className="flex min-h-[44px] items-center justify-between gap-space-3 border-b border-border py-space-3 text-lg last:border-b-0"
                >
                  {/* "A pays B", which is the direction — the figure beside it is an amount to
                      move, not a balance, so it carries no direction word of its own. */}
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
        </Card>
      </section>

      {/* docs/ui.md's Record payment action, which is the primary action here: the form opens on
          the screen rather than behind a disclosure, because a group settling up records several
          payments in a row and a control that has to be pressed again between them is a step for
          nothing. The write, the busy state and the refusals are PaymentForm's. */}
      <section className="flex flex-col gap-space-2">
        <h2 className="text-xl">Record payment</h2>
        <PaymentForm
          group={group}
          members={members}
          defaultFrom={defaultFrom}
          defaultTo={defaultTo}
        />
      </section>

      {/* The recorded payments themselves. They are here rather than on the activity screen —
          which is a later piece — because a payment has to be deletable to be correctable, and
          the delete control needs a row to live on. Each row says what moved and when; the delete
          is offered only to the two members the payment involves. */}
      {payments.length > 0 ? (
        <section className="flex flex-col gap-space-2">
          <h2 className="text-xl">Payments</h2>
          <ul className="flex flex-col">
            {payments.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-col gap-space-2 border-b border-border py-space-3 last:border-b-0"
              >
                <div className="flex items-center justify-between gap-space-3">
                  <span className="truncate">{paymentLabel(payment)}</span>
                  <span className="shrink-0 text-sm text-text-muted">
                    {payment.createdAt.toISOString().slice(0, 10)}
                  </span>
                </div>
                {payment.note ? (
                  <p className="text-sm text-text-muted">{payment.note}</p>
                ) : null}
                {payment.fromMemberId === viewerMemberId || payment.toMemberId === viewerMemberId ? (
                  <div>
                    <DeletePaymentButton
                      groupId={group.id}
                      paymentId={payment.id}
                      description={paymentLabel(payment)}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <nav aria-label="Group" className="flex flex-wrap gap-space-2">
        <Link
          href={`/groups/${group.id}`}
          className="inline-flex min-h-[44px] items-center rounded-radius border border-border bg-surface px-space-4 font-medium"
        >
          Overview
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
