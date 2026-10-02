import { describe, expect, it } from 'vitest';

import {
  netBalances,
  simplifyDebts,
  sumBalances,
  summariseForViewer,
  type MemberLedger,
  type NetBalance,
  type Transfer,
  type ViewerGroupBalances,
} from '@/lib/balances';

/**
 * The settlement algorithm, as arithmetic rather than through a screen.
 *
 * Every case here is a pure function of its arguments, which is the point of the module: TR-6's
 * three guarantees — exactness, the n − 1 bound and determinism — are asserted directly against
 * a known answer instead of being inferred from what a page happened to render.
 */

/**
 * Six members, one expense ledger's worth of nets, and a hand-computed settlement.
 *
 * The amounts are chosen so the greedy path has to make BOTH kinds of choice: two debtors
 * equally owed from (e and f, 7000 each) and two debtors equally short at the end (d and f,
 * 1000 each). A tie-break that was missing or unstable would show up here as a different list.
 */
const ids = { a: 'm-a', b: 'm-b', c: 'm-c', d: 'm-d', e: 'm-e', f: 'm-f' } as const;

const six: NetBalance[] = [
  { memberId: ids.a, balanceMinor: 9000n },
  { memberId: ids.b, balanceMinor: 6000n },
  { memberId: ids.c, balanceMinor: 3000n },
  { memberId: ids.d, balanceMinor: -4000n },
  { memberId: ids.e, balanceMinor: -7000n },
  { memberId: ids.f, balanceMinor: -7000n },
];

const expected: Transfer[] = [
  { fromMemberId: ids.e, toMemberId: ids.a, amountMinor: 7000n },
  { fromMemberId: ids.f, toMemberId: ids.b, amountMinor: 6000n },
  { fromMemberId: ids.d, toMemberId: ids.c, amountMinor: 3000n },
  { fromMemberId: ids.d, toMemberId: ids.a, amountMinor: 1000n },
  { fromMemberId: ids.f, toMemberId: ids.a, amountMinor: 1000n },
];

/** Applies a settlement to the balances it came from, and says whether everybody is square. */
function settle(balances: NetBalance[], transfers: Transfer[]): Map<string, bigint> {
  const after = new Map(balances.map((balance) => [balance.memberId, balance.balanceMinor]));
  for (const transfer of transfers) {
    after.set(transfer.fromMemberId, (after.get(transfer.fromMemberId) ?? 0n) + transfer.amountMinor);
    after.set(transfer.toMemberId, (after.get(transfer.toMemberId) ?? 0n) - transfer.amountMinor);
  }
  return after;
}

describe('net balances', () => {
  it('is paid minus shared, per member, from the stored rows alone', () => {
    const ledger: MemberLedger[] = [
      { memberId: ids.a, paidMinor: 10000n, sharedMinor: 2500n },
      { memberId: ids.b, paidMinor: 0n, sharedMinor: 7500n },
    ];

    expect(netBalances(ledger)).toEqual([
      { memberId: ids.a, balanceMinor: 7500n },
      { memberId: ids.b, balanceMinor: -7500n },
    ]);
  });

  it('sums to zero for any ledger whose paid and shared totals agree', () => {
    // The invariant every balance rests on: an expense puts the same total into the paid rows
    // and the shared rows, so the two sides cancel at group level whatever the split was.
    const ledger: MemberLedger[] = [
      { memberId: ids.a, paidMinor: 3333n, sharedMinor: 0n },
      { memberId: ids.b, paidMinor: 0n, sharedMinor: 1111n },
      { memberId: ids.c, paidMinor: 0n, sharedMinor: 1111n },
      { memberId: ids.d, paidMinor: 0n, sharedMinor: 1111n },
    ];

    expect(sumBalances(netBalances(ledger))).toBe(0n);
  });
});

describe('simplifyDebts', () => {
  it('produces the hand-computed settlement for six members', () => {
    expect(simplifyDebts(six)).toEqual(expected);
  });

  it('reproduces the balances exactly, in at most n − 1 transfers', () => {
    const transfers = simplifyDebts(six);

    for (const [memberId, remaining] of settle(six, transfers)) {
      expect(remaining, `member ${memberId} was not settled`).toBe(0n);
    }

    // n is the number of members with a non-zero balance, not the size of the group.
    const n = six.filter((balance) => balance.balanceMinor !== 0n).length;
    expect(n).toBe(6);
    expect(transfers).toHaveLength(n - 1);

    // Never more than n − 1, whatever the shape of the balances — this is the bound TR-6 states.
    expect(simplifyDebts(six).length).toBeLessThanOrEqual(n - 1);
  });

  it('never moves more than the group owed, and never from a creditor', () => {
    const transfers = simplifyDebts(six);
    const credit = six.reduce(
      (total, balance) => (balance.balanceMinor > 0n ? total + balance.balanceMinor : total),
      0n,
    );

    expect(transfers.reduce((total, transfer) => total + transfer.amountMinor, 0n)).toBe(credit);
    for (const transfer of transfers) {
      expect(transfer.amountMinor).toBeGreaterThan(0n);
      expect(transfer.fromMemberId).not.toBe(transfer.toMemberId);
    }
  });

  it('is a function of the balances rather than of the array they arrive in', () => {
    // Bit-for-bit the same answer for any permutation: every tie is broken on a property of the
    // balance, so a caller reading them from a query with no ORDER BY cannot get a different
    // settlement for the same group.
    const shuffled = [...six].reverse();
    expect(simplifyDebts(shuffled)).toEqual(expected);

    const rotated = [...six.slice(3), ...six.slice(0, 3)];
    expect(simplifyDebts(rotated)).toEqual(expected);

    // And the same array twice is the same answer, because nothing here is random.
    expect(simplifyDebts(six)).toEqual(simplifyDebts(six));
  });

  it('settles a two-member group with one transfer, and a square group with none', () => {
    expect(
      simplifyDebts([
        { memberId: ids.a, balanceMinor: 18050n },
        { memberId: ids.b, balanceMinor: -18050n },
      ]),
    ).toEqual([{ fromMemberId: ids.b, toMemberId: ids.a, amountMinor: 18050n }]);

    // TR-9: everybody square is no transfers at all, which is what the screens turn into the
    // settled sentence rather than rendering a zero.
    expect(simplifyDebts([])).toEqual([]);
    expect(
      simplifyDebts([
        { memberId: ids.a, balanceMinor: 0n },
        { memberId: ids.b, balanceMinor: 0n },
      ]),
    ).toEqual([]);
  });

  it('throws rather than inventing a settlement when the balances do not sum to zero', () => {
    const broken: NetBalance[] = [
      { memberId: ids.a, balanceMinor: 1000n },
      { memberId: ids.b, balanceMinor: -900n },
    ];

    expect(() => simplifyDebts(broken)).toThrow(/sum to 100 minor units rather than zero/);
    // Not a precondition the caller can satisfy by rounding: nothing in the product can produce
    // an unbalanced ledger, so this is a defect being surfaced rather than a state being handled.
    expect(() => simplifyDebts([])).not.toThrow();
  });
});

describe('the home summary', () => {
  const members = [
    { memberId: ids.a, displayName: 'Ana', balanceMinor: 2000n },
    { memberId: ids.b, displayName: 'Sam', balanceMinor: -2000n },
  ];

  it('counts only the transfers the caller is one end of', () => {
    const group: ViewerGroupBalances = {
      viewerMemberId: ids.a,
      members,
      transfers: [
        { fromMemberId: ids.b, toMemberId: ids.a, amountMinor: 2000n },
        // Between two other people: nothing the caller has to do, and nothing they owe.
        { fromMemberId: 'm-x', toMemberId: 'm-y', amountMinor: 5000n },
      ],
    };

    const totals = summariseForViewer([group]);

    expect(totals.owedMinor).toBe(2000n);
    expect(totals.oweMinor).toBe(0n);
    expect(totals.owedBy).toEqual([{ memberId: ids.b, displayName: 'Sam', amountMinor: 2000n }]);
    expect(totals.oweTo).toEqual([]);
  });

  it('reads a transfer the caller pays as something they owe', () => {
    const totals = summariseForViewer([
      {
        viewerMemberId: ids.b,
        members,
        transfers: [{ fromMemberId: ids.b, toMemberId: ids.a, amountMinor: 2000n }],
      },
    ]);

    expect(totals.oweMinor).toBe(2000n);
    expect(totals.owedMinor).toBe(0n);
    expect(totals.oweTo).toEqual([{ memberId: ids.a, displayName: 'Ana', amountMinor: 2000n }]);
  });

  it('adds up across groups, with the per-person lines summing to each total', () => {
    const one: ViewerGroupBalances = {
      viewerMemberId: ids.a,
      members,
      transfers: [{ fromMemberId: ids.b, toMemberId: ids.a, amountMinor: 2000n }],
    };
    const two: ViewerGroupBalances = {
      viewerMemberId: ids.a,
      members: [
        { memberId: ids.c, displayName: 'Dev', balanceMinor: 750n },
        { memberId: ids.a, displayName: 'Ana', balanceMinor: -750n },
      ],
      transfers: [{ fromMemberId: ids.a, toMemberId: ids.c, amountMinor: 750n }],
    };

    const totals = summariseForViewer([one, two]);

    expect(totals.owedMinor).toBe(2000n);
    expect(totals.oweMinor).toBe(750n);
    expect(totals.owedBy.reduce((total, line) => total + line.amountMinor, 0n)).toBe(totals.owedMinor);
    expect(totals.oweTo.reduce((total, line) => total + line.amountMinor, 0n)).toBe(totals.oweMinor);
  });

  it('keeps two people who share a name apart, because they are two ledger positions', () => {
    const totals = summariseForViewer([
      {
        viewerMemberId: ids.a,
        members: [
          { memberId: ids.a, displayName: 'Ana', balanceMinor: 0n },
          { memberId: ids.b, displayName: 'Sam', balanceMinor: 0n },
        ],
        transfers: [{ fromMemberId: ids.b, toMemberId: ids.a, amountMinor: 1000n }],
      },
      {
        viewerMemberId: ids.a,
        members: [
          { memberId: ids.a, displayName: 'Ana', balanceMinor: 0n },
          { memberId: ids.c, displayName: 'Sam', balanceMinor: 0n },
        ],
        transfers: [{ fromMemberId: ids.c, toMemberId: ids.a, amountMinor: 2000n }],
      },
    ]);

    // Collapsing by display name would show one Sam owed 3000; there are two, and the lines
    // this screen draws are per membership.
    expect(totals.owedBy).toHaveLength(2);
    expect(totals.owedBy.map((line) => line.displayName)).toEqual(['Sam', 'Sam']);
    expect(totals.owedMinor).toBe(3000n);
  });

  it('orders the lines largest first, and says nothing at all for a caller in no groups', () => {
    const totals = summariseForViewer([
      {
        viewerMemberId: ids.a,
        members: [
          { memberId: ids.a, displayName: 'Ana', balanceMinor: 0n },
          { memberId: 'm-small', displayName: 'Bo', balanceMinor: 0n },
          { memberId: 'm-large', displayName: 'Cy', balanceMinor: 0n },
        ],
        transfers: [
          { fromMemberId: 'm-small', toMemberId: ids.a, amountMinor: 100n },
          { fromMemberId: 'm-large', toMemberId: ids.a, amountMinor: 900n },
        ],
      },
    ]);

    expect(totals.owedBy.map((line) => line.displayName)).toEqual(['Cy', 'Bo']);

    expect(summariseForViewer([])).toEqual({ owedMinor: 0n, oweMinor: 0n, owedBy: [], oweTo: [] });
  });

  it('names a counterparty that is not in the member list rather than rendering undefined', () => {
    // Not reachable through the pages — the members and the transfers come from one read — but a
    // breakdown line reading "undefined" is worse than an anonymous one.
    const totals = summariseForViewer([
      {
        viewerMemberId: ids.a,
        members: [{ memberId: ids.a, displayName: 'Ana', balanceMinor: 0n }],
        transfers: [{ fromMemberId: 'm-gone', toMemberId: ids.a, amountMinor: 100n }],
      },
    ]);

    expect(totals.owedBy[0]?.displayName).toBe('Member');
  });
});
