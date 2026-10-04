# Bug patterns

One file per recurring bug shape, named for the **symptom** — that is what a future agent
searches for, not the cause.

Each entry states: the symptom as observed, the actual cause, how it was found, and how to
check for it quickly. Written by the Librarian after a bug turns out to be non-obvious.

- [User-typed number overflows an int8 column with a 500 instead of a field error](int8-overflow-500-instead-of-field-error.md) —
  applies when any form accepts an unbounded numeric input: a 250-500 from shaped-valid input
  is a missing bound, not a driver fault. Grep parsers against columns, not tests against QA.
- [A successful action lands nowhere](action-success-lands-nowhere-effect-vs-unmount.md) —
  applies to any `useActionState` write whose success changes the route: navigation and
  refresh must live in the awaited continuation, not a `useEffect` on state.
