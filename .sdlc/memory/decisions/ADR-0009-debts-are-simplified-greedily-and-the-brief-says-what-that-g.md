# ADR-0009: Debts are simplified greedily, and the brief says what that guarantees

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
src/lib/balances.ts computes each member's net balance, separates creditors from debtors, and repeatedly settles the largest debtor against the largest creditor. The result is deterministic for a given set of balances, sums to zero, and uses at most n − 1 transfers where n is the number of members with a non-zero balance.

## Why
The spec asks for the fewest payments and asks us to state which algorithm and what it guarantees. The true minimum is a subset-sum partition problem and is not solvable in polynomial time, so no algorithm offers it. Greedy largest-first is the standard answer, is O(n log n), and the bound it does provide is a guarantee a user can be told about plainly.

## Consequences
Easy: the result is explainable to a person ('you owe A, B pays C'), deterministic, and cheap enough to run on every group page. Hard: it is not always the mathematical minimum, so a group can need one more transfer than strictly necessary, and the guarantee must be stated in the interface to the user rather than implied. Do not add 'optimal' to any copy about it.
