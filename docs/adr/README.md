# Architecture Decision Records

`docs/design/` states the design as it is now. It is not the place for a rejected
alternative, and it should not have to carry a rule only because an earlier rule
was wrong. That is what an ADR holds.

The split keeps the design series readable as a specification. A reader who wants
to know what `scope` means reads `00-terminology.md`. A reader who wants to know
why `scope` and `binding` are separate concepts reads ADR 0001.

ADR format is [MADR](https://adr.github.io/madr/), short form.

## When to write one

Write an ADR when a change does any of these:

- removes, renames or retires a term, a tool, a parameter or a document that
  older text cites;
- picks one of two designs a reader could reasonably have expected;
- contradicts a rule that `docs/design/` currently states.

A change that only adds detail to a decision already recorded belongs in the
design series. A change that is not yet decided belongs in `docs/rfcs/`.

## Status

| Status | Meaning |
|---|---|
| `Proposed` | Written and under review. No code depends on it yet. |
| `Accepted` | The code and `docs/design/` follow it. |
| `Superseded by NNNN` | Replaced. The file stays, and the link points forward. |
| `Rejected` | Considered and not taken. The reasoning is the value. |

A decision is never deleted. Mark it superseded and record what replaced it.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-split-supervision-scope-from-io-binding.md) | Split supervision scope from I/O binding, and retire `carrier` | Accepted |
| [0002](0002-retire-the-turn-scope.md) | Retire the `turn` scope and its settle-time forced kill | Accepted |
| [0003](0003-universal-detached-pipe-supervisor.md) | One detached pipe supervisor for both scopes | Accepted |
| [0004](0004-remove-the-pane-binding-and-shell-attach.md) | Remove the `pane` binding and `shell_attach` | Accepted |
| [0005](0005-pty-wrapper-foreground-signal-disposition.md) | Run `script(1)` in the foreground of the PTY wrapper | Accepted |
| [0006](0006-retire-session-promotion.md) | Retire the `to: "session"` promotion direction | Accepted |
| [0007](0007-bound-the-pty-recording-without-touching-the-process.md) | Bound a `pty` recording with a writer, not with `script(1)` | Accepted |
| [0008](0008-read-coupling-from-a-matrix.md) | Read coupling from a matrix, and split a module by change reason | Accepted |

ADR 0001 to 0004 are backfilled. They record decisions the design series already
carries, written down as decisions so that the design no longer has to explain
its own history.
