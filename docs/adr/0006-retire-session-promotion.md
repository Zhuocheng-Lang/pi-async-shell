# 0006. Retire the `to: "session"` promotion direction

- **Status:** Accepted
- **Applies to:** 0.2.3
- **Supersedes:** none
- **Design:** `docs/design/03-execution-model-and-primitives.md` §3.4

## Context

`shell_promote` has always been one-directional: it moves a live `session`
execution to `workspace` ownership, and the design states that no demotion
exists. The parameter type said something else. `to` was
`"session" | "workspace"`, and the registry accepted `"session"` on an
execution that was already `session` by rewriting the scope and persisting the
record, which is a write for a request that asked for no change. On a
`workspace` execution the same value raised "cannot narrow to session", so the
one direction the type offered was the one direction the model forbids.

Two things made that worth removing rather than documenting. The tool schema
offered a value whose only reachable behaviour was a no-op or an error, so a
caller could not tell from the schema that promotion is a single move. And the
no-op was not free: it rewrote `meta.json` and emitted a change event, which
reads as a state transition to every observer of the registry.

## Options

| Option | What it costs | Why it was not taken |
|---|---|---|
| Keep the value as an idempotent no-op | Nothing at run time | It advertises a direction that does not exist, and it writes a record for a request that changes nothing. An old text that cites it keeps working, which is the only argument for it |
| Keep the value and refuse it in the registry only | A clearer error than a schema error | The schema is what a model reads. A value that can only fail is noise in the one place that should state the contract |
| Remove `to` entirely | A smaller schema | A caller that already passes `to: "workspace"` — the skill, the durability fixtures, and every test — would then be passing an unknown property, which the host may reject or silently drop depending on its validation mode |
| `to` optional, `"workspace"` the only value, registry refuses `"session"` with its reason | One optional parameter that carries a single value | Taken |

## Decision

`to` is optional and accepts `"workspace"` alone. Omitting it performs the
same move. `ShellPromoteParams.to` stays typed as `Scope` rather than as the
literal, so the registry can still recognise `"session"` at run time and answer
it with the reason instead of a schema error, which matters to a programmatic
caller and to a test that pins the behaviour.

The registry refuses `"session"` on both scopes. On a `session` execution the
refusal replaces what used to be a no-op write; on a `workspace` execution it
replaces "cannot narrow to session".

## Consequences

- A model that reads the tool schema sees one value, and the parameter's
  description says why there is only one.
- A caller that still passes `to: "session"` learns that promotion is
  one-directional. The host rejects it at the schema boundary; a direct registry
  caller gets the registry's message.
- The idempotent no-op is gone, so `shell_promote` on a `session` execution
  with `to: "session"` no longer writes `meta.json` or emits a change event.
- `shell_promote` on an execution that is already `workspace` still returns
  the handle unchanged, which is the idempotence a caller actually needs: the
  tool is safe to repeat with `to: "workspace"` or with no `to` at all.
- The bundled skill already shows `shell_promote({ id, to: "workspace" })`, and
  that call keeps working unchanged.

## Evidence

`tests/registry.test.ts` — "promotion refuses the retired to: session direction", "promotion widens default pipe and pty sessions to workspace"; `tests/pty.test.ts` — "a live pty can be promoted to workspace".
