# 0002. Retire the `turn` scope

- **Status:** Accepted
- **Applies to:** 0.2.0
- **Supersedes:** none
- **Design:** `docs/design/01-overview.md` sections 5 and 8.1; `docs/design/00-terminology.md` section 10

## Context

`turn` named the current agent turn as the owner of an execution. Its enforcement
was a forced kill at the settle boundary: a `turn`-scoped execution still running
when the turn ended was an error, and the runtime injected a continuation
describing the error.

That made the scope axis 3 wide, and it made the narrowest scope the only one a
caller would reach for when what they wanted was a barrier. A caller who needs
"do not proceed until this finishes" was expressing an ordering wish and
acquiring an owner as a side effect.

## Options

| Option | What it costs | Why it was not taken |
|---|---|---|
| Keep `turn` | A 3 x 2 space | It duplicates `shell_await` for in-turn causality and makes a turn boundary destructive |
| Keep `turn`, drop the kill | A scope whose contract is `session` | Two names for one behaviour |
| Remove the scope | A caller must choose a real owner, or a wait | Taken |

## Decision

The scope axis has two values, `session` and `workspace`. A turn boundary cancels
nothing. A caller who needs a causal barrier inside one turn calls `shell_await`,
which narrows the wait and changes no ownership.

## Consequences

- `agent_before_settle` forced cancellation and the `async-shell-error`
  continuation are removed.
- `cancelOnFirstFailure` is removed: it only had meaning inside a turn-scoped
  group.
- `session` becomes the narrowest scope and survives the turn, so the reason
  `shell_start` does not block is stated by the scope alone.
- The space is 2 x 2. A later scope addition is one row.

## Evidence

`tests/registry.test.ts` asserts that `turn` is rejected rather than silently
given settle-time semantics.
