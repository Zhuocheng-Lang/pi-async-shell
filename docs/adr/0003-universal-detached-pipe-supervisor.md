# 0003. One detached pipe supervisor for both scopes

- **Status:** Accepted
- **Applies to:** 0.2.0
- **Supersedes:** none
- **Design:** `docs/design/03-execution-model-and-primitives.md` section 3.4; `docs/design/04-runtime-architecture.md` section 2.1

## Context

A `session` pipe execution had its stdout and stderr teed in-process, and only a
`workspace` execution wrote files. A live process cannot have its descriptors
rebound, so a `session` pipe could not become a `workspace` pipe without a
respawn. The design recorded that limitation as a rule: "a `pipe` execution cannot
be promoted".

The rule described the implementation, not the model. It also carried a second
consequence the design did not state: a `session` execution's output died with
Pi, while a `pty` execution's did not, because the pty recipe was already
detached and file-bound.

## Options

| Option | What it costs | Why it was not taken |
|---|---|---|
| Keep the in-process tee | Cheap to start | A pipe cannot be promoted, and its output dies with Pi |
| Respawn on promotion | A second process, a lost prefix | Promotion would stop being lossless |
| Detach every pipe | One supervisor process per execution, at both scopes | Taken |

## Decision

Every `pipe` execution runs under `src/core/pipe-supervisor.mjs`, detached, with
its child's stdout and stderr owned by that supervisor and written to
`stdout.log`, `stderr.log` and `combined.log`. The only scope difference is an
fd 3 owner watch. Promotion writes `release` into that watch; the supervisor stops
watching and the command is untouched.

## Consequences

- Promotion is lossless for both bindings: same process, same pid, same files, no
  respawn.
- There is one spawn path for pipes, so one path to test and one path to reason
  about at a crash boundary.
- A `session` execution's output now survives a hard Pi exit. `session` means the
  session owes a cleanup; it no longer means the output is volatile. That changed
  what adopting a session scope costs, and the survey treats it as a capability
  rather than an accident.
- The log cap had to become a drain-and-discard policy at both scopes. Stopping
  the read would block the child on a full pipe.

## Evidence

`tests/pty-durability.test.ts` ("a promoted default pipe survives the Pi that
promoted it") and `tests/workspace.test.ts` ("a promoted default pipe record
enters the workspace scan").
