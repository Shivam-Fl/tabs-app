# Memory index

One line per entry, describing **when it applies** — an agent reads this before deciding
whether to open the entry itself.

## Always
- [project.md](project.md) — stack, layout, commands. Read before any planning.
- [conventions.md](conventions.md) — naming, errors, tests, PR style. Read before writing code.
- [docs/prd.md](../../docs/prd.md) — what is being built, for whom, and what deliberately is not. Read before planning a feature.
- [docs/trd.md](../../docs/trd.md) — the numbered TR- requirements an issue's `Covers:` line cites. Read before planning or reviewing.
- [docs/ui.md](../../docs/ui.md) — theme tokens, patterns and every screen's five states. Read before touching anything a user sees.

## Situational
- [qa/environment.md](qa/environment.md) — the preview server may be a build composed before
  your branch's code existed; sign-up's third field is required; post-write navigation must
  not sit in an effect. Read before any browser walk, hand-run rebuild or QA verdict, and
  before reporting a pass.
- [qa/selectors.md](qa/selectors.md) — the field-error id convention, the `input.<memberId>`
  name shape, which amounts are mono spans vs the direction-worded `Money` primitive, and the
  `?left=` / `?deleted=` URL contracts. Read before writing a component test or a QA case.
- [patterns/](patterns/) — bug shapes this repo has produced before. Grep by symptom: an
  int8 column that answers a 500 to a shaped-valid number; an action whose success lands
  nowhere because the unmount killed the effect.
- [decisions/](decisions/) — ADR-0001 to ADR-0011, the stack settled once for #1: one data
  layer with two drivers, no REST layer, migrations on boot, hand-rolled sessions. Read the
  relevant one before proposing an alternative; each names what it rejected and why.
