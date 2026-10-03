/**
 * The new-expense screen has no loading state, and this file is what says so.
 *
 * docs/ui.md's Expense form · loading is "For edit only", and its · partial is "Not reachable:
 * the form holds no data that can arrive separately from the members, and the members are
 * loaded before the form renders". Without this file the segment would inherit
 * ../loading.tsx and flash five list-shaped rows where a form is about to appear — a skeleton
 * in the wrong shape is worse than none. A segment with nothing to wait for renders nothing
 * while it waits.
 */
export default function Loading() {
  return null;
}
