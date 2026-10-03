/**
 * An amount, with its direction in words.
 *
 * It takes a pre-formatted string rather than a bigint because this primitive must never do
 * arithmetic on money — it formats nothing and computes nothing. Tabular figures in --font-mono
 * so a column of money aligns on the decimal point.
 *
 * The direction is a WORD beside the number rather than a colour or a minus sign on it (TR-23),
 * and the word is visible to everyone: it was sr-only until this screen, which made the colour
 * the only signal a sighted reader had — the one thing "never colour alone" forbids.
 *
 * `voice` is whose balance the row is. The viewer's own figure — the home total, the group's row
 * on the list, the viewer's own row on the members screen — reads "you are owed"; a row labelled
 * with somebody else's name reads "is owed", because a table of every member labelled "you" is a
 * table nobody can read. Only the pronoun changes: the two voices say the same thing about the
 * same sign.
 *
 * Callers: GroupOverview, MembersScreen, GroupList and BalancesScreen, all of which pass it the
 * result of src/lib/money.ts's formatMinor.
 */

/**
 * The words and the colour for each direction, in both voices, in one place.
 *
 * Exported because the home summary renders its two totals itself: docs/ui.md puts the label
 * above the figure there and the figure at --text-2xl, so the two cannot share a line, and a
 * second copy of "you are owed" in a second file is a second thing to keep in step. Colour and
 * words travel together for the same reason — the words are what makes the colour allowed.
 */
export const DIRECTION = {
  owed: { words: { you: 'you are owed', person: 'is owed' }, colour: 'text-positive' },
  owes: { words: { you: 'you owe', person: 'owes' }, colour: 'text-negative' },
  settled: { words: { you: 'settled', person: 'settled' }, colour: 'text-text' },
} as const;

export type Direction = keyof typeof DIRECTION;

/**
 * Which way a balance reads. Zero is 'settled' rather than a third kind of amount: TR-9's whole
 * point is that a group where everybody is square says so instead of rendering a zero transfer.
 *
 * It lives beside the primitive because src/lib/money.ts is explicit that direction is not its
 * business — it formats a figure and takes no view on which way it points — so the sign is read
 * once, here, and every screen derives it the same way.
 */
export function directionOf(balanceMinor: bigint): Direction {
  if (balanceMinor > 0n) return 'owed';
  if (balanceMinor < 0n) return 'owes';
  return 'settled';
}

export function Money({
  formatted,
  direction,
  voice = 'you',
}: {
  formatted: string;
  direction: Direction;
  voice?: 'you' | 'person';
}) {
  return (
    <span className={`font-mono tabular-nums ${DIRECTION[direction].colour}`}>
      <span className="text-sm">{DIRECTION[direction].words[voice]}</span> {formatted}
    </span>
  );
}
