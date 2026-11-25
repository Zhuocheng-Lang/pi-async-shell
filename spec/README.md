# Specifications

A test pins the traces someone thought of. A state machine is checked against
every interleaving a simulator can reach, up to a step bound. `docs/design/`
states the contract in prose and `tests/` pins the cases the design names; these
files cover the gap.

The specifications are [Quint](https://quint-lang.org/). The checker is a
devDependency pinned at `0.34.0`, so every checkout reads the model with the
version it was last checked with instead of whatever `@latest` serves that day.
`pnpm verify` does not run it, because a model is read when a contract changes,
not on every commit.

## Running one

`pnpm install` puts `quint` in `node_modules/.bin`, and three scripts run the
check:

```sh
pnpm run spec:typecheck   # quint typecheck
pnpm run spec:run         # quint run, 5000 samples, 20 steps
pnpm run spec             # both
```

`pnpm verify` and CI leave these three out on purpose; a contract that changes
is what asks for them. The scripts expand to:

```sh
pnpm exec quint typecheck spec/handle-lifecycle.qnt
pnpm exec quint run spec/handle-lifecycle.qnt \
  --max-samples=5000 --max-steps=20 --invariant=invariants
```

`quint run` is a random simulator. It explores traces, stops at the first one
that violates an invariant, and prints that trace. Raise `--max-samples` and
`--max-steps` to search wider, and pass the `--seed` from a previous run to
reproduce a trace; a run that takes its own seed prints that seed and the
backend to pass back in on its last line.

The install includes the checker, not the evaluator. `quint run` defaults to the
`rust` backend, which downloads a pinned `rust-evaluator` binary into
`~/.quint/` on its first run and reuses it afterwards; `--backend=typescript`
runs without that download. Neither path runs at `pnpm install` time.

The pinned `0.34.0` was checked against this model on 2026-11-25:
`pnpm run spec:typecheck` reported nothing, and `pnpm run spec:run` reported
`[ok] No violation found`.

## handle-lifecycle.qnt

The completion and promotion contract: C3, C9 and R1. It answers three questions
a test list cannot enumerate:

- can one settle be reported twice, once inside a tool result and once as a
  message;
- can ownership move twice, which the design forbids because there is no
  demotion;
- can a session execution report after the owner that owed its cleanup reaped it.

Two invariants carry those questions: `oneReportPerExecution` and
`promotionIsOneWay`. `invariants` is their conjunction, and it is what
`--invariant` takes.

## Adding one

Copy `handle-lifecycle.qnt`, change the state, and write the invariant before
the actions. Then delete the guard that enforces it and confirm the simulator
finds the trace. An invariant that no action can violate is not a check.
