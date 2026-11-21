# Requests for Comments

`docs/design/` is normative and `docs/adr/` is decided. An RFC is where a design
is argued before either is true.

## When to open one

Open an RFC for a change that does any of these:

- adds or removes a tool, a scope, a binding or a lifecycle state;
- changes a crash-recovery, ownership or replay contract (C1 to C10, R1 to R4);
- needs a modelling or measurement argument rather than a paragraph.

Everything smaller goes straight to an ADR or to a design edit.

## Lifecycle

| Status | Meaning |
|---|---|
| `Draft` | Under the author's hand. Not ready for review. |
| `Review` | Ready for comment. The RFC says what kind of comment it wants. |
| `Accepted` | Merged into `docs/design/`. The RFC stays as the record and links to its ADR. |
| `Rejected` | Not taken. The reasoning is kept, because the next person will ask again. |

An accepted RFC is never deleted. Number it, link it, leave it.

## Modelling a proposal

A concurrency proposal is easier to judge as a state machine than as prose. The
Quint specifications under `spec/` are the working model: copy one, change the
invariant, and let the simulator produce the counterexample. `spec/README.md`
lists the commands. An RFC that changes ownership, promotion or cancellation
should link the spec it was checked against.
