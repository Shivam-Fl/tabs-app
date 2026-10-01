# ADR-0011: The split rule is stored with the expense; the shares it produced are stored beside it

**Date:** 2026-10-01
**Status:** accepted
**Forced by:** #1

## Decision
Every expense carries its split_type, and one expense_split_input row per included member holds the number that member was given. An edit replaces that set and the expense's expense_payer and expense_share rows in one transaction with the expense's activity entry. Balances are still summed from expense_payer and expense_share alone: the stored rule is read only to redisplay the edit form and to say what an edit changed.

## Why
The maintainer asked for the rule and not only its result, so an edit reopens showing exactly what was entered and an activity entry can name what changed. Without it the form can only guess at what was typed — a percentage split comes back as the shares it produced — and 'changed from equal to exact' is unfalsifiable. Keeping the rule and the result in separate tables is what stops the rule from becoming a second source of truth for balances: the rule is an input, the shares are the ledger, and only the ledger is summed.

## Consequences
Easy: the edit form is a direct render of the stored inputs; an activity entry can diff old inputs against new and name the fields that moved; QA can assert an exact round trip of what was typed. Hard: an expense write now touches three child tables instead of two, so the transaction and its sum assertions carry more; changing the stored input's unit is a migration over stored history rather than a code change; and the rule table is a trap for anyone who sums it by mistake, so exactly one function computes a share from a rule, it is called only on the write path, and no read path calls it.
