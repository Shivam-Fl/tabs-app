# Decisions

One file per decision that would otherwise be re-litigated: `ADR-NNN-short-title.md`.

Each states the context, the decision, what was rejected and why, and the date. A decision
without its rejected alternatives is a preference; with them it is an argument a future agent
can check against its own situation rather than guess at.

Written when a choice costs something to reverse — a data model, an auth approach, a
dependency, a convention the whole repo now follows. Not for anything a diff already explains.

ADR-0001 to ADR-0011 were written together by the project planner for #1, the one architecture
gate that runs before the first ticket. They are the reason several ordinary choices are not
open for debate: one data layer with two drivers, no REST layer, migrations on boot, hand-rolled
sessions. Read the one that covers your change before re-proposing an alternative — most of
them name the rejected option and the reason, so a counter-proposal has to answer that reason
rather than restate the choice.

Further ADRs are written as tickets earn them.
