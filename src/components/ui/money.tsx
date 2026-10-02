/**
 * An amount, with its direction in words.
 *
 * It takes a pre-formatted string rather than a bigint because src/lib/money.ts is piece 4's
 * and this primitive must never do arithmetic on money — it formats nothing and computes
 * nothing. Tabular figures in --font-mono so a column of money aligns on the decimal point.
 *
 * No caller yet: nothing in this ticket stores an amount.
 */
export function Money({ formatted, direction }: { formatted: string; direction: 'owed' | 'owes' | 'settled' }) {
  const words = { owed: 'you are owed', owes: 'you owe', settled: 'settled' } as const;
  const colour = {
    owed: 'text-positive',
    owes: 'text-negative',
    settled: 'text-text',
  } as const;

  return (
    <span className={`font-mono tabular-nums ${colour[direction]}`}>
      {/* The direction is a word, never a minus sign and never colour alone. */}
      <span className="sr-only">{words[direction]}: </span>
      {formatted}
    </span>
  );
}