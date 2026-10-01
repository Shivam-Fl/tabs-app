# ADR-0008: Money is bigint minor units, and a split is stored as its shares

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
Every amount is a bigint count of minor units in a bigint column. Equal, percentage and share splits are computed at write time with bigint floor division and the whole remainder assigned to the first payer in the split's member order; the resulting per-member amounts are written to an expense_shares table. Balances read those stored shares and the stored per-payer amounts, and never re-evaluate a split rule.

## Why
The spec requires that a split never loses or invents a paisa and that the remainder rule be stated and tested. Storing the computed shares is what makes that checkable and what makes a balance stable: without them, editing an expense's split type would silently restate what people already owed, and removing a member would erase their history from everyone else's balance.

## Consequences
Easy: the sum invariant is a single assertion at the point of write and a property test can prove it; a balance is a plain sum over rows; changing the split rule later cannot rewrite the past. Hard: bigint does not serialise to JSON, so amounts cross the server/client boundary as decimal strings; and editing an expense must recompute its shares in the same transaction, which is more work than re-deriving them on read.
