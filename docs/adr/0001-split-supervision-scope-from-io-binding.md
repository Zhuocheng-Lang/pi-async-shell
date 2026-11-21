# 0001. Split supervision scope from I/O binding

- **Status:** Accepted
- **Applies to:** 0.2.0
- **Supersedes:** none
- **Design:** `docs/design/01-overview.md` sections 3, 4 and 5; `docs/design/04-runtime-architecture.md` section 1

## Context

An earlier draft named one concept, `carrier`, for the pair (owner, stdio
topology). Because it was one word, every sentence about it asserted an
implication between the two halves. Two of those implications were false:

- that cross-process persistence requires a terminal multiplexer;
- that PTY semantics require a terminal multiplexer.

Both were checked against this machine rather than argued. `setsid(1)` plus a
supervisor that writes file-bound logs gives a process that outlives Pi with no
broker. `script(1)` allocates a real PTY with no external process. A multiplexer
buys exactly one narrower thing: a long-lived broker that owns the PTY master, so
that a third party can attach to the same terminal later.

## Options

| Option | What it costs | Why it was not taken |
|---|---|---|
| Keep `carrier` | One word per cell | It asserts owner/binding implications that nobody chose, and two of them are false |
| One axis with six values | One word per cell, and no implication | The six values are not mutually exclusive; two of them are the same execution |
| Two independent axes | A sentence that means both must name both | Taken |

## Decision

Scope and binding are separate axes. `scope` names the owner that guarantees
cleanup and must not exit while the execution runs. `binding` names where the
bytes go and whether a terminal is involved. A scope and a binding combine
freely. `carrier` is retired.

## Consequences

- The space is a 2 x 2 grid with four reachable cells, including `workspace` +
  `pty`, which the fused word had declared infeasible.
- Every sentence that used `carrier` had to be rewritten. Two documents changed
  their argument, not just their vocabulary.
- `03-carrier-and-runtime-architecture.md` became `04-runtime-architecture.md`.
  The rename map is in `docs/design/05-durability-and-containment.md` section 8.
- A future addition to either axis is a one-row or one-column change. A future
  addition to a fused word would have been a rewrite.

## Evidence

`docs/design/01-overview.md` section 4 rules R2 to R4, and the reachability of
`workspace` + `pty` under test in `tests/pty.test.ts`.
