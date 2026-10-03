/**
 * Net balances, the simplified debts that settle them, and the home screen's totals.
 *
 * A balance is a sum of stored rows and never a re-evaluation of the stored split rule (TR-4),
 * so nothing here knows or asks what split type produced the amounts it is handed: it takes each
 * member's paid total and shared total as src/lib/access.ts read them out of expense_payer and
 * expense_share, and subtracts. The stored rule — split_type and expense_split_input — is not a
 * parameter of any function in this file, which is what makes "a change to the split algorithm
 * cannot restate what people already owed" true by construction rather than by convention.
 *
 * Everything is a pure function of its arguments — no database, no clock, no randomness — so the
 * algorithm's guarantees are tested directly instead of through a screen, and every amount is a
 * bigint count of minor units (TR-2). There is no float here and no division that could make one.
 */

/**
 * One member's ledger halves: what they paid, and what they were given. Both are sums over
 * stored rows, and neither is derived from the rule that produced them.
 */
export interface MemberLedger {
  memberId: string;
  paidMinor: bigint;
  sharedMinor: bigint;
}

/** One member's net position. Positive is a credit: the group owes them. */
export interface NetBalance {
  memberId: string;
  balanceMinor: bigint;
}

/** A net balance with the name the screen renders beside it. */
export interface NamedBalance extends NetBalance {
  displayName: string;
}

/** One settlement: `fromMemberId` pays `toMemberId` `amountMinor`. */
export interface Transfer {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: bigint;
}

/**
 * The sentence a non-zero balance earns, shared by the action that refuses the write and the
 * screen that withholds the control. It lives here, beside the notion of a settled balance,
 * because the two must read identically: a control hidden with one sentence and a refusal
 * returned with another is a person told two different things about the same rule.
 */
export const SETTLE_FIRST_MESSAGE =
  "A member whose balance isn't zero can't leave or be removed. Settle up first.";

/**
 * What a group where everybody is square says, in place of a transfer list (TR-9).
 *
 * docs/ui.md gives it verbatim, with an ASCII apostrophe: U+2019 renders as the same sentence
 * and is a different string, and tests/components/group-overview-empty.test.tsx reads the design
 * document to assert the difference. The balances screen and the group overview render this one
 * constant, so the two cannot drift into saying it two slightly different ways.
 */
export const SETTLED_MESSAGE = "Everyone's square in this group.";

/**
 * Who the home summary is talking about: a counterparty, and what the caller owes them or is
 * owed by them across every group that loaded.
 *
 * `memberId` is a membership row rather than a person, so the same human in two groups is two
 * entries that happen to share a name. That is deliberate: two memberships are two ledger
 * positions with two balances, and collapsing them by display name would merge two different
 * people who happen to be called Sam into one line, which is a wrong number rather than a
 * repetition.
 */
export interface Counterparty {
  memberId: string;
  displayName: string;
  amountMinor: bigint;
}

/** What the home screen's two figures say, and what each of them is made of. */
export interface HomeSummaryTotals {
  /** What the caller is owed in total. Zero when nothing is outstanding in their favour. */
  owedMinor: bigint;
  /** What the caller owes in total, as a positive magnitude. */
  oweMinor: bigint;
  /** "you are owed" line by line: who owes the caller, and how much. Sums to `owedMinor`. */
  owedBy: Counterparty[];
  /** "you owe" line by line: who the caller owes, and how much. Sums to `oweMinor`. */
  oweTo: Counterparty[];
}

/** paid − shared for each member, in the order given. */
export function netBalances(ledger: MemberLedger[]): NetBalance[] {
  return ledger.map((member) => ({
    memberId: member.memberId,
    balanceMinor: member.paidMinor - member.sharedMinor,
  }));
}

/** The total the balances add up to. Zero whenever the ledger is intact. */
export function sumBalances(balances: NetBalance[]): bigint {
  return balances.reduce((total, balance) => total + balance.balanceMinor, 0n);
}

/** What is still standing on one side of the settlement. */
interface Standing {
  memberId: string;
  /** What is still to be moved, always positive. */
  remainingMinor: bigint;
}

/**
 * Takes the largest standing entry, ties going to the lower member id.
 *
 * The tie-break is not decoration: without one, two members owed the same amount would be
 * resolved by whichever happened to sit first, and TR-6 requires that the same balances always
 * yield the same transfers. The member id is the key because it is a property OF the balance
 * rather than of the array it arrived in: keyed on position, shuffling the same six balances
 * would produce a different settlement, and "the same balances" does not mean "the same array".
 * Which of two equal creditors pays first is arbitrary either way — both settlements are
 * correct — so the tie-break only has to be stable, and this one is stable across any order.
 */
function takeLargest(standing: Standing[]): Standing {
  let best = 0;
  for (let position = 1; position < standing.length; position += 1) {
    const candidate = standing[position];
    const current = standing[best];
    if (
      candidate.remainingMinor > current.remainingMinor ||
      (candidate.remainingMinor === current.remainingMinor && candidate.memberId < current.memberId)
    ) {
      best = position;
    }
  }
  return standing.splice(best, 1)[0];
}

/**
 * The fewest transfers greedy matching produces over these balances (TR-6).
 *
 * Largest creditor against largest debtor, repeatedly: every round moves the whole smaller of
 * the two remainders, so at least one of the pair is settled by it and the loop runs at most
 * n − 1 times, where n is the number of members whose balance is non-zero. The transfers
 * reproduce the balances exactly — applying them zeroes every member — because each one moves
 * money from someone who is short to someone who is owed, by an amount neither of them can
 * exceed.
 *
 * The balances must sum to zero. That is not a precondition to be checked by the caller: an
 * unbalanced ledger means the paid and shared rows disagree, which nothing in the product can
 * produce, so it is a programming error and this throws rather than inventing a settlement for
 * money that is not there. A page asserts the sum first and answers with its error state, so a
 * broken read is a sentence rather than a stack trace.
 *
 * Determinism is over the balances rather than over the array they arrive in (TR-6): every
 * tie-break is on a property of the balance, so the same members with the same nets produce the
 * same transfers however they are ordered — which is what a caller reading them from a query
 * with no ORDER BY needs, and what makes the result reproducible across two runs.
 *
 * The true minimum is a subset-sum partition and is not solvable in polynomial time; the
 * guarantee stated here is the one greedy actually provides, and it is stated rather than
 * implied.
 */
export function simplifyDebts(balances: NetBalance[]): Transfer[] {
  const total = sumBalances(balances);
  if (total !== 0n) {
    throw new Error(
      `tabs: balances sum to ${total} minor units rather than zero, so no settlement can be produced — ` +
        'every expense contributes the same total to the paid rows and the shared rows, so a non-zero sum means the ledger was read or written inconsistently',
    );
  }

  const creditors: Standing[] = [];
  const debtors: Standing[] = [];
  for (const balance of balances) {
    if (balance.balanceMinor > 0n) {
      creditors.push({ memberId: balance.memberId, remainingMinor: balance.balanceMinor });
    } else if (balance.balanceMinor < 0n) {
      debtors.push({ memberId: balance.memberId, remainingMinor: -balance.balanceMinor });
    }
  }

  const transfers: Transfer[] = [];
  while (creditors.length > 0 && debtors.length > 0) {
    const creditor = takeLargest(creditors);
    const debtor = takeLargest(debtors);
    const amountMinor =
      creditor.remainingMinor < debtor.remainingMinor ? creditor.remainingMinor : debtor.remainingMinor;

    transfers.push({ fromMemberId: debtor.memberId, toMemberId: creditor.memberId, amountMinor });

    creditor.remainingMinor -= amountMinor;
    debtor.remainingMinor -= amountMinor;
    // Whichever side still has something left goes back in for the next round; the side that
    // reached zero is finished and never appears in another transfer.
    if (creditor.remainingMinor > 0n) creditors.push(creditor);
    if (debtor.remainingMinor > 0n) debtors.push(debtor);
  }

  return transfers;
}

/** Largest first, then by name so two equal amounts still render in the same order every time. */
function byAmountThenName(left: Counterparty, right: Counterparty): number {
  if (left.amountMinor !== right.amountMinor) return left.amountMinor > right.amountMinor ? -1 : 1;
  return left.displayName.localeCompare(right.displayName);
}

/** One group's part of the home summary: the caller's own row, the members, and the transfers. */
export interface ViewerGroupBalances {
  /** The caller's membership row in this group, so a transfer can be read from their side. */
  viewerMemberId: string;
  members: NamedBalance[];
  transfers: Transfer[];
}

/**
 * What the home screen's two figures total, and the per-person lines beneath each (TR-8).
 *
 * Only the transfers the caller is an end of are counted, which is what makes this per person
 * rather than per group: a transfer between two other members settles something the caller has
 * no part in. Each group contributes at most one transfer per counterparty — greedy pairs a
 * member once before one of the pair is exhausted — so a line is one counterparty and one
 * amount, and the two lists sum to the two totals by construction rather than by assertion.
 */
export function summariseForViewer(groups: ViewerGroupBalances[]): HomeSummaryTotals {
  const owedBy: Counterparty[] = [];
  const oweTo: Counterparty[] = [];

  for (const group of groups) {
    const nameOf = new Map(group.members.map((member) => [member.memberId, member.displayName]));
    for (const transfer of group.transfers) {
      const line = (counterpartyId: string): Counterparty => ({
        memberId: counterpartyId,
        displayName: nameOf.get(counterpartyId) ?? 'Member',
        amountMinor: transfer.amountMinor,
      });

      if (transfer.fromMemberId === group.viewerMemberId) oweTo.push(line(transfer.toMemberId));
      else if (transfer.toMemberId === group.viewerMemberId) owedBy.push(line(transfer.fromMemberId));
    }
  }

  owedBy.sort(byAmountThenName);
  oweTo.sort(byAmountThenName);

  return {
    owedMinor: owedBy.reduce((total, line) => total + line.amountMinor, 0n),
    oweMinor: oweTo.reduce((total, line) => total + line.amountMinor, 0n),
    owedBy,
    oweTo,
  };
}
