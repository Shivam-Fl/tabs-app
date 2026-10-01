# UI

_Generated from `project-brief.json` for #1. Every ticket follows this rather
than inventing its own — five screens each inventing their own spacing is how one product
ends up looking like five._

## Theme

| token | value | used for |
|---|---|---|
| `--color-bg` | `#ffffff` | The page background behind every screen. |
| `--color-surface` | `#f7f8fa` | Cards, list rows, table headers — anything raised off the page. |
| `--color-border` | `#e3e6ea` | Dividers, input borders, card outlines. Never used for emphasis. |
| `--color-text` | `#14181f` | Body text and headings. |
| `--color-text-muted` | `#5b6675` | Secondary text: timestamps, hints, empty-state descriptions. Must still meet 4.5:1 against --color-bg. |
| `--color-primary` | `#1f5eff` | The single action colour: primary buttons, links, selected nav. One action colour per screen, never two. |
| `--color-primary-contrast` | `#ffffff` | Text on --color-primary. Contrast against it is 4.6:1. |
| `--color-positive` | `#0a7c4a` | Money you are owed, and settled state. Never the primary action colour. |
| `--color-negative` | `#b3261e` | Money you owe, validation errors, destructive confirmations. Never used for anything that is merely important. |
| `--color-focus` | `#1f5eff` | The focus ring, 2px with a 2px offset. A visible ring on every focusable element, never removed. |
| `--space-1` | `4px` | Inside a control, between a label and its input. |
| `--space-2` | `8px` | Between related items in a list, padding inside a small control. |
| `--space-3` | `12px` | Between a form field and the next; card padding on a phone. |
| `--space-4` | `16px` | Card padding at desktop, gap between list sections. |
| `--space-6` | `24px` | Between page sections; page padding on a phone. |
| `--space-8` | `32px` | Page padding at desktop; above an h1. |
| `--radius` | `8px` | Cards, inputs, buttons. One radius for the product. |
| `--font-body` | `system-ui, -apple-system, 'Segoe UI', sans-serif` | Everything. No web font: it is a second failure mode and a second second to load. |
| `--font-mono` | `ui-monospace, 'SF Mono', Menlo, monospace` | Amounts and identifiers, so a column of money aligns. |
| `--text-sm` | `14px` | Secondary text, timestamps, helper text. |
| `--text-base` | `16px` | Body. Never below 16px for an input, or the phone zooms on focus. |
| `--text-lg` | `20px` | h3 and card titles. |
| `--text-xl` | `24px` | h2. |
| `--text-2xl` | `30px` | h1, and the one large number on a balance screen. |

**Typography.** One family, the system UI stack. h1 is --text-2xl, h2 --text-xl, h3 --text-lg, body --text-base, secondary --text-sm. Line height 1.5 for body, 1.2 for headings. Amounts use --font-mono with tabular figures so columns of money align on the decimal point. Never bold for emphasis alone — an amount that is owed or owed-by is distinguished by colour and by the words beside it, so the information survives a screen reader.

**Density.** Comfortable, and it does not change by screen. A list row is --space-3 of vertical padding and a minimum touch target of 44px, which is the constraint that actually governs phone layout. Rows are not cards on a phone; cards are for grouping within a screen, and a list of expenses is a list.

**Motion.** Two things only: a 150ms ease-out colour transition on interactive elements, and an instant appearance for anything that arrives after a submit. No layout animation, no skeleton shimmer beyond a static placeholder, and prefers-reduced-motion removes the first. An amount appearing is never animated — a number that moves is a number that cannot be read.

**Dark mode.** Not in this version. The tokens above are light-only and no screen contains a colour literal, so adding a dark set later is a matter of overriding the same names in the @theme block — but no ticket may add a dark mode, a theme switcher or a prefers-color-scheme rule on its own, because a partial dark mode is worse than none. A ticket that needs it adds every token at once.

## Patterns

### Form error

Validate on the server, render the error next to the field that caused it, in --color-negative, in the field's own --text-sm, and focus the first invalid field. The form-level message is only for failures with no field: a wrong current password, a rate limit, a conflict. Never a toast for a validation error — it disappears before it is read and it is not next to the thing that caused it.

_Example._ "That is 240 short of ₹1,000. Check the amounts." beneath the amount field, in the field's own space, displacing nothing.

### Empty state

Every list has one, and there are two kinds and they are never confused. No data yet: a sentence saying what will be here, plus the single action that creates the first one. No results: what was searched or filtered, plus a way to clear it. An empty state is never an illustration and never an apology.

_Example._ No expenses yet — "Add the first expense for this group." with an Add expense button. Against a filter: "No expenses match these filters." with a Clear filters button.

### Loading

A static skeleton in the shape of what is coming, not a spinner and not a shimmer. Under 200ms, show nothing — a flash of skeleton is worse than a flash of content. Over 200ms, the skeleton. Over 10 seconds, the skeleton plus a line saying it is taking longer, because an indefinite skeleton reads as a broken page.

_Example._ Three grey rows at list-row height where the expenses will be, with no spinner and no animation.

### Error

A failed page load says what failed in one sentence, keeps any content that did load on screen, and offers one action: try again. A failed action that is a submission reports next to the field per the form rule, and does not navigate away from what the person was doing. Never a raw error, a stack trace, or an error code.

_Example._ "Couldn't load this group's expenses." with a Try again button, and the group's name and balance still shown above it.

### Destructive action

Confirm in a dialog that names the thing being destroyed and states the consequence in one sentence, with the confirm button in --color-negative. Leaving a group, removing a member, deleting an expense and deleting a payment all confirm. Archiving a group does not — it is reversible and the owner is the only one who can do it.

_Example._ "Remove Priya from Lisbon? She will no longer appear in this group's balances." with Cancel and a Remove Priya button in --color-negative.

### Message after an action

No toasts. A successful write updates the screen it happened on, and a change that a person cannot see — leaving, removing, deleting — confirms in place with a short line that names what changed and, where it is reversible, offers Undo. The only exception is a cross-screen navigation, where the destination states the result.

_Example._ After leaving a group, the group list shows the row with "You left Lisbon · Undo" for ten seconds.

### Money

Always rendered by src/lib/money from a bigint, in the group's currency, in --font-mono. A positive balance is "you are owed" in --color-positive and a negative one is "you owe" in --color-negative; a bare minus sign is never the only signal. On a balance screen the direction is a word beside the number, not a colour applied to it alone.

_Example._ "You are owed ₹420.00" and "You owe ₹180.50", never "₹-180.50".

### Lists

One row per record, newest first where recency is the point. Every row is a whole-row link or a whole-row button, not a link around a fragment. Filters and search sit above the list in one row on a phone and never inside it, and the active filter is shown as a removable chip so its presence is never a surprise.

_Example._ A row: description on the left, amount on the right, who paid and the date in --text-sm beneath.

### Navigation

A single top bar with the app name, the user's groups and a profile link; the group's name with Back on a group sub-screen. No hamburger, no bottom tab bar: every screen is at most two taps from the home screen, and a phone-width layout puts the primary action in view rather than behind a menu.

_Example._ Group sub-screens show "← Lisbon" at the top, which is a real link back to the group.

## Screens

### Home — /

**Answers.** What do I owe and what am I owed, across everything, and which group do I want to look at next.

**Regions.** Page header with the app name and a profile link. A summary block of exactly two figures — you owe, you are owed — each with its per-person breakdown directly beneath. Below it, the list of the user's groups, each row showing the name, the type, and the user's net balance in it, newest activity first. A single primary action, Create group, at the top right on a laptop and as a full-width button below the summary on a phone.

- **ideal** — The two summary figures at --text-2xl in --color-negative and --color-positive, then the groups. The signed-in user's own name is not repeated — the page is about them.
- **empty** — No groups at all: "You're not in any groups yet." with Create group as the single action, and a second, quieter line inviting them to open an invite link. This is the most important empty state in the product and it is where a new user arrives.
- **loading** — Skeleton for the two figures and three group rows. The figures are placeholders, not zeros — a zero reads as 'you owe nothing'.
- **partial** — One group's data fails while the rest load: the summary and the other groups render, and the failing row shows its own inline error with Try again. The summary is never rendered from a partial set, because a total of the groups that happened to load is a lie; it is withheld until every group's balance is in.
- **error** — Nothing loads: "Couldn't load your balances." with Try again. The header and the Create group action still render, so the page is never a dead end.

**Narrow.** One column at every width. At 360px the two figures sit side by side at --text-xl rather than stacking, because comparing them is the whole job; above 600px the content is capped at a readable measure and centred, and the group list gains a second column.

### Group overview — /groups/[id]

**Answers.** Where does this group stand right now, and what is the two most recent things that happened in it.

**Regions.** Header with the group name, type and currency, and a Back link to home. A balance summary: the user's net balance in this group, stated as a direction and a figure. A simplified-debts block listing the transfers, each "A pays B ₹X". A short recent-activity list, five entries, linking to the full feed. A secondary action row: Add expense as the primary action, with Balances, Members and Activity as links.

- **ideal** — Summary, transfers, five recent entries. If every balance is zero this screen says so in place of the transfer list, in the group's own words.
- **empty** — A new group with no expenses: the balance summary shows everyone at zero, the transfer list is replaced by the settled message, and recent activity says "Nothing here yet — add the first expense."
- **loading** — Skeleton for the summary, three transfer rows and five activity rows.
- **partial** — Activity fails to load: the balance summary and transfers — the numbers a person came for — still render, and only the activity block shows its inline error.
- **error** — The group cannot be read at all: the group name is not shown (the caller may not be a member, and 404 is the answer), and the page says the group is unavailable with a link home.

**Narrow.** One column. On a phone the primary action is a full-width button directly under the header, because it is the thing that happens most often; on a laptop it moves to the header.

### Expenses — /groups/[id]/expenses

**Answers.** What has been spent, what is still owed from it, and to add, edit or remove any of it.

**Regions.** Header with the group name and Back. A single row above the list holding search and the member and category filters, each shown as a removable chip when active. The list itself, newest first, one row per expense: description, amount, who paid, the date, and a category chip when set. Add expense as the primary action, full-width on a phone.

- **ideal** — The list with the active filters visible as chips. Each row is a link to the expense, where it can be edited or deleted.
- **empty** — Two distinct states, per the pattern: no expenses yet, with Add expense as the action; and no matches, naming the filters and offering Clear filters. These are never the same screen.
- **loading** — Skeleton rows at list height, five of them, matching the shape of a real row so nothing jumps when they land.
- **partial** — Filters are local to the list, so this state is rare: when it happens, the list renders with a line above it saying the results may be incomplete, rather than an error that replaces the list.
- **error** — "Couldn't load this group's expenses." with Try again, keeping the filters so a retry does not lose them.

**Narrow.** Filters wrap onto two lines below 480px and stay on one above it. The amount stays right-aligned and never wraps to its own line — a column of money that wraps is a column that cannot be scanned.

### Expense form — /groups/[id]/expenses/new and /[id]/edit

**Answers.** Record what was paid, who paid it and how it splits, in one pass, without leaving the screen.

**Regions.** Header with the group name and Back. Description, amount with the currency symbol fixed beside it, date, optional category, optional note. A participant picker listing the group's members with checkboxes for who is in the split, and a split-type control offering equally, exact amounts, percentages and shares, which changes the inputs shown without navigating. On edit the split type, the checked participants and every entered number come from the expense's stored rule in the order they were saved, so the form reopens showing exactly what was typed rather than a re-normalised version of it; a member who has since left the group is still listed, checked, with their name as it was. A live-updating summary line stating what the split resolves to and, for an invalid one, exactly what is off and by how much. Save as the primary action, full-width on a phone.

- **ideal** — The live summary line updates as the split is edited, so a person sees the shares resolve before they save. On edit the fields arrive populated and the summary states what the stored shares resolve to, so saving an untouched form writes the same expense again.
- **empty** — A new expense with the amount and description empty and the participant picker defaulting to every active member. On edit there is no empty state to design: every field is populated from the stored expense, including a split with a remainder, which is shown as entered and not rewritten into an equal share.
- **loading** — For edit only, a skeleton of the populated form so the layout does not jump when it lands.
- **partial** — Not reachable: the form holds no data that can arrive separately from the members, and the members are loaded before the form renders.
- **error** — Field errors render next to their fields, in --color-negative, and focus moves to the first one — never a toast, never a summary-only error. A submit that fails for a reason with no field (a conflict, a rate limit) shows a form-level message above the actions and keeps every value the person typed.

**Narrow.** One column. Exact amounts, percentages and shares use a two-column member-and-value row on a phone, with the member name above its value rather than beside it.

### Balances — /groups/[id]/balances

**Answers.** Who owes whom in this group, in as few transfers as possible, and to record one.

**Regions.** Header with the group name and Back. A per-member table of net balances, each stated as a direction and a figure. Below it, the simplified transfer list — "A pays B ₹X" — which is the answer, not the table. A Record payment action as the primary action, opening a small form: from, to, amount, optional note.

- **ideal** — The table and the transfer list, in that order, with the transfer list the visually dominant block. A payment recorded appears in the group's feed and the balances move without a page reload.
- **empty** — A group with no members other than the user: the table shows their own zero balance and the transfer list is replaced by the settled message — "Everyone's square in this group."
- **loading** — Skeleton for the table rows and three transfer rows.
- **partial** — Not reachable: both blocks come from one balance computation, so they are correct or absent together.
- **error** — "Couldn't load this group's balances." with Try again.

**Narrow.** The table becomes a list of rows below 480px, one member per row, with the amount still right-aligned.

### Activity — /groups/[id]/activity and /activity

**Answers.** What has happened in this group, or across all of them, and who did it.

**Regions.** Header with the title — the group name, or Activity for the cross-group feed — and Back. A single reverse-chronological list, each entry stating what happened, to whom, and by whom, with a relative time in --text-sm and an absolute time in the title attribute. The cross-group feed additionally names the group on every entry.

- **ideal** — The list, newest first, grouped by day with a date heading in --text-sm.
- **empty** — A group with no activity: "Nothing has happened in this group yet." The cross-group feed with none: "No activity across your groups yet." Neither offers an action — the thing that creates activity is an expense, which the reader has just done or has not.
- **loading** — Skeleton rows of three lines each, matching the real entry shape.
- **partial** — Not reachable: the feed is one query, so it is complete or absent.
- **error** — "Couldn't load the activity." with Try again, keeping the title.

**Narrow.** One column at every width, capped and centred above 600px. Long descriptions truncate to one line in the feed; the full text is never the reason a row is three lines tall.

### Members and invite — /groups/[id]/members

**Answers.** Who is in this group, what they are owed or owe, how to add someone, and what to do about a placeholder.

**Regions.** Header with the group name and Back. A list of members, each showing display name, their balance in the group, and their role; the owner is marked. Each member row carries the actions available to the viewer: leave, remove, or claim, decided by role and balance. Below the list, the invite link with Copy link as the primary action, and a control to turn the link off or make a new one, owner-only. Add a placeholder member as a secondary action.

- **ideal** — The member list with balances, the invite link, and the owner-only controls visible to the owner and absent for everyone else.
- **empty** — Not reachable: the creator is a member from the moment the group exists, so the list always has at least one row.
- **loading** — Skeleton rows for the members, with the invite block skeletoned too, since the token must not flash as absent before arriving.
- **partial** — Not reachable: one query.
- **error** — "Couldn't load this group's members." with Try again.

**Narrow.** One column. On a phone the per-member actions move from the row into a single overflow menu at the right of the row, so a two-word name is never squeezed by three buttons.

### Settings, sign-in and sign-up — /settings, /sign-in, /sign-up

**Answers.** The person's own details, and getting in or out.

**Regions.** Settings: display name and default currency, one Save button. Sign-in and sign-up: one centred card, no site navigation beyond the brand name, one primary button, and a link to the other form. Sign-out lives in the profile menu on every other screen.

- **ideal** — Settings shows the current values. Sign-in and sign-up show a single field set, focused on the email input on arrival.
- **empty** — Not applicable: every field is populated or is an input awaiting a person. There is no data on these screens to be empty.
- **loading** — Sign-in and sign-up have no loading state before submit. On submit the primary button is disabled and reads "Signing in…", which is the only busy state any screen uses.
- **partial** — Not applicable: nothing on these screens loads in pieces.
- **error** — A failed sign-in or sign-up shows one form-level message above the button, in --color-negative, identical in wording whether the email is unknown or the password is wrong. A failed save on settings keeps every value and shows the message above Save.

**Narrow.** The card is capped at 360px and centred at every width. Below 480px it spans the width with --space-6 of page padding and no card border, so it does not look like a dialog on a phone.

## Accessibility

- Every page has exactly one h1, and heading levels descend without skipping. QA checks this on every screen.
- Every control has a visible label. A placeholder is never the only label; placeholders are hints, in --color-text-muted, and disappear on focus.
- Focus is visible on every focusable element: a 2px --color-focus ring at 2px offset, never removed. QA tabs through a form and confirms a ring at every stop.
- Every screen is fully operable by keyboard, in a logical order: the top bar, then the page's primary action, then the content, then any dialog. A dialog traps focus while open and returns it to the control that opened it on close.
- A destructive confirmation is reachable and dismissible by keyboard, and Escape cancels it.
- Body text meets 4.5:1 against its background and large text 3:1; --color-text-muted on --color-bg is 5.6:1 and is not used below --text-sm. QA checks contrast on the tokens, not on individual screens.
- Money is never conveyed by colour alone. A positive or negative balance is stated in words — "you are owed", "you owe" — beside the figure, so it survives both a screen reader and a colour-blind reader.
- Every form error is associated with its input through aria-describedby and announced, and focus moves to the first invalid field on submit. Errors are never signalled by red alone.
- Loading, empty and error states are in the DOM as text, not conveyed by a spinner or a colour, and a state change is announced in a live region where it replaces content the person was reading.
- Touch targets are at least 44px by 44px, and no control is within 8px of another control's edge, so a phone does not produce mis-taps.
- The app is usable at 200% browser zoom with no horizontal scrolling and no loss of content, and respects prefers-reduced-motion.
- Every image and icon-only control carries a text alternative or an accessible name; an icon-only button is never labelled by its glyph alone.
