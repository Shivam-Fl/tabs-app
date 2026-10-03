# A successful action lands nowhere: navigation and the unmount that kills it

## Symptom

A Server Action commits its write and answers `ok: true` — and the browser either stays put
showing the wrong thing or lands somewhere broken. Three concrete shapes, all merged in the
same 24h:

- **Leave** — membership ends, but the client stays on `/groups/<id>/members`, which
  revalidates into the not-found page ("This group isn't available") instead of
  `/?left=<id>` with its Undo notice. QA filed this as BUG-1 against #22.
- **Join by link** — the confirm writes the membership and returns ok, but the person stays
  on the invite screen; the landing never navigated.
- **Archive** — the write lands, the URL carries the archived notice, but the button sits
  showing its `busyLabel="Archiving…"` forever (`#19`, fixed before merge).

## Cause

Two mechanisms, both common in Server Actions + `useActionState` code, which is why they are
written down together:

1. **The effect-loses-the-race shape.** Navigation triggered by a `useEffect` on action
   state never runs when the same commit that delivers the state also unmounts the component
   holding the effect. Leaving (and deleting, and joining) each revalidate a route that then
   renders not-found for a person who is no longer a member — TR-1 requires exactly that —
   so the unmount is not a bug; it is the authorisation working. The effect dies with the
   component; the write already happened.
2. **The busyLabel-never-clears shape.** `Button` renders `busyLabel` in place of children
   for the whole time it is `disabled`, so a `disabled={pending || finished}` with a fixed
   busy label makes a finished action claim to still be working.

## The fix, and the rule it generalises to

Do navigation in the **awaited continuation** of the action, not in an effect on its state:

```tsx
const wrapped = async (previous, formData) => {
  const result = await action(previous, formData);
  if (result.ok) router.push(...);   // runs even if the component unmounts mid-await
  return result;
};
const [state, formAction, pending] = useActionState(wrapped, null);
```

A pending promise is not part of the tree; nothing unmounts it, so the continuation still
runs. It is written out in full, with the reason, on `useMemberAction`
(src/components/member-actions.tsx) and on `DeleteExpenseButton`
(src/components/delete-expense-button.tsx). For a screen where the write itself makes this
screen render differently (join), the alternative shape is to make the whole screen one
client component rather than two server branches, so a re-render reconciles in place instead
of replacing the form that was about to navigate (#22).

If the success is visible on the same page, the *other* half of the rule from #19 applies:
`revalidatePath` in an action purges the cache but does not re-render the current page, so
the client component calls `router.refresh()` — ArchiveButton's comment says so in as many
words. A refactor that "cleans up" either pattern back into an effect reintroduces the bug
class, and jsdom cannot catch it: only a real browser walk of the exact unmount sequence
does.
