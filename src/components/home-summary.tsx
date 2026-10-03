import { DIRECTION, type Direction } from '@/components/ui';
import type { Counterparty, HomeSummaryTotals } from '@/lib/balances';
import { formatMinor } from '@/lib/money';

/**
 * The home screen's summary block: exactly two figures — what the caller is owed and what they
 * owe — each with its per-person breakdown directly beneath (docs/ui.md, Home · Regions).
 *
 * Presentational and synchronous, like the list it sits above. The two totals and their lines
 * arrive already computed from src/lib/balances.ts; nothing here adds up, and nothing here
 * renders at all when a group failed to load — a total of the groups that happened to answer is
 * a lie, so the page withholds the block instead (docs/ui.md, Home · partial).
 *
 * The label sits ABOVE the figure rather than beside it, which is what docs/ui.md's Narrow rule
 * needs: at 360px the two figures stay side by side because each block is a narrow column, and
 * a single line of "you are owed €420.00" at --text-xl would wrap the pair into a stack.
 */
export function HomeSummary({
  totals,
  currency,
}: {
  totals: HomeSummaryTotals;
  /**
   * The groups' own currency. The caller's totals are sums of group amounts, so the symbol has
   * to be one those amounts were recorded in; the page passes the shared one and a user whose
   * groups disagree is the mixed-currency gap this piece flags rather than solves.
   */
  currency: string;
}) {
  return (
    <section aria-label="Your balances" className="flex items-start gap-space-6">
      <Figure
        direction="owed"
        totalMinor={totals.owedMinor}
        counterparties={totals.owedBy}
        currency={currency}
      />
      <Figure
        direction="owes"
        totalMinor={totals.oweMinor}
        counterparties={totals.oweTo}
        currency={currency}
      />
    </section>
  );
}

/** One of the two: the direction as its label, the total under it, and who makes it up. */
function Figure({
  direction,
  totalMinor,
  counterparties,
  currency,
}: {
  direction: Direction;
  totalMinor: bigint;
  counterparties: Counterparty[];
  currency: string;
}) {
  const { words, colour } = DIRECTION[direction];

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-space-1">
      <span className="text-sm text-text-muted">{words.you}</span>
      {/* The word is the label directly above, so the figure is not colour alone (TR-23) — and
          the figure itself is what docs/ui.md sizes at --text-2xl. */}
      <span className={`font-mono tabular-nums text-xl sm:text-2xl ${colour}`}>
        {formatMinor(totalMinor, currency)}
      </span>
      {counterparties.length > 0 ? (
        <ul className="flex flex-col">
          {counterparties.map((line) => (
            // Keyed by membership rather than by name: the same person in two groups is two
            // lines, because they are two ledger positions. The breakdown carries no direction
            // word of its own — every line under "you are owed" points the same way, which is
            // what the label above them says.
            <li
              key={line.memberId}
              className="flex items-baseline justify-between gap-space-2 text-sm"
            >
              <span className="truncate">{line.displayName}</span>
              <span className="shrink-0 font-mono tabular-nums">
                {formatMinor(line.amountMinor, currency)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
