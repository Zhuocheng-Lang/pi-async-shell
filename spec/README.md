# Specifications

A test pins the traces someone thought of. A state machine is checked against
every interleaving a simulator can reach, up to a step bound. `docs/design/`
states the contract in prose and `tests/` pins the cases the design names; these
files cover the gap.

The specifications are [Quint](https://quint-lang.org/). They are not a build
step and not a dependency. `pnpm verify` does not run them, because a model is
read when a contract changes, not on every commit.

## Running one

Quint runs from npm with no install:

```sh
npx @informalsystems/quint@latest typecheck spec/handle-lifecycle.qnt
npx @informalsystems/quint@latest run spec/handle-lifecycle.qnt \
  --max-samples=5000 --max-steps=20 --invariant=invariants
```

`quint run` is a random simulator. It explores traces, stops at the first one
that violates an invariant, and prints that trace. Raise `--max-samples` and
`--max-steps` to search wider, and pass the `--seed` from a previous run to
reproduce a trace.

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
