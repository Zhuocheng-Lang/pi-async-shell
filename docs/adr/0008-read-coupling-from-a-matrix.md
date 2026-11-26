# 0008. Read coupling from a matrix, and split a module by change reason

- **Status:** Accepted
- **Applies to:** 0.2.3
- **Supersedes:** none
- **Design:** `docs/design/04-runtime-architecture.md` §1, `docs/design/04-runtime-architecture.md` §8

## Context

The design series says where the seam is: the registry knows nothing about Pi's
messaging, and the extension layer decides what a settle becomes. It does not
say how much code sits on each side, and by 0.2.3 the answer was lopsided. Of
18 modules under `src/`, two held 52% of the lines: `registry.ts` at 1628 and
`extension.ts` at 1363.

A matrix of the import graph, ordered so that a dependency lands below the
diagonal, showed why that matters and why the usual remedy does not apply. The
tree had **zero cycles and zero feedback edges** across 31 edges, so nothing was
tangled. It was coarse: one module carried ten dependencies and five separate
change reasons — durable records, log deltas, key chords, replay keys, the
execution state machine — and a reader reviewing any one of them has to read all
of them.

The matrix is also the answer to "should this repository take a tool for this?".
It runs in 0.1 s over 22 modules and it resolves every relative specifier in the
tree, because the conventions leave nothing to resolve: imports are relative and
carry the `.ts` extension, and `tsconfig.json` has no path aliases.

## Options

| Option | What it costs | Why it was not taken |
|---|---|---|
| Add `dependency-cruiser` as a devDependency | 18 direct dependencies including a resolver, a YAML/JS config and an interactive CLI | It earns its keep on a tree with aliases, workspaces and barrel files. Here it would resolve what a regular expression already resolves, and `CONTRIBUTING.md` gives a devDependency entry to a package this repository runs, the way `quint` is pinned for `pnpm run spec` |
| Add `madge` or `skott` | 13 and 25 direct dependencies | Neither produces a DSM: no partition, no feedback marks, no propagation cost. The cycle list they do produce was already empty |
| Split `registry.ts` into shared state plus collaborators | A redesign of the ownership model the durability guarantees rest on | It is the right eventual change, and it is not a refactor. `this.executions`, the write lock and the adoption path are one invariant; moving them apart needs the invariant restated first, which is an RFC, not a commit |
| Keep the matrix as a report and extract the clusters that are already leaves | Four new modules to name in the notes | Taken |

## Decision

`scripts/dsm.mjs` builds the matrix from the import graph with no dependencies,
partitions it by strongly connected component, and reports propagation cost,
feedback edges and per-module fan-in, fan-out and reach. `pnpm dsm` runs it. It
prints a report and enforces nothing, so it cannot become a gate that a
missing analyser blocks.

The modules that the matrix showed as self-contained moved out of the two large
files. `src/core/keys.ts` holds the key table, `src/core/utf8.ts` holds the
window boundary, `src/core/records.ts` holds the on-disk record primitives, and
`src/presentation.ts` holds every string a person or a model reads back.
Presentation imports types and nothing else, so the most frequently edited part
of the package now sits at the bottom of the graph instead of the top.

## Consequences

- `registry.ts` is 1450 lines and `extension.ts` is 1249, down from 1628 and
  1363. Their share of `src/` falls from 52% to 45%.
- Propagation cost falls from 13.3% to 11.4%, and `records.ts` reaches three
  modules instead of six: reading bytes out of a log no longer depends on the
  terminal replay model.
- The centre does not move. `registry.ts` still has fan-out 12 and `extension.ts`
  still reaches 19 of 22 modules, because both are orchestrators, and an
  orchestrator with twelve dependencies is a smaller problem than an
  orchestrator with five reasons to change.
- The next change with a matrix behind it is the state-machine split in
  `registry.ts` and the tool-definition split in `extension.ts`. Both need an
  explicit context object where there are closures today, so both are design
  changes and belong in `docs/rfcs/` before they are code.
- A cycle gate is deliberately absent. If the first feedback edge appears, that
  is the thing to enforce, because a cycle is the one property that turns a
  module into a piece that cannot be reviewed alone.

## Evidence

Before, on 18 modules: `node scripts/dsm.mjs` reported 31 edges, density 10.1%,
propagation cost 13.3%, longest chain 5, and no cycle. After, on 22 modules: 38
edges, density 8.2%, propagation cost 11.4%, longest chain 5, no cycle.

`pnpm typecheck` is clean and `pnpm test` passes 140 of 140 with the four modules
extracted. `dependency-cruiser@18.9.0`, `madge@8.0.0` and `skott@0.35.12` report
their direct dependency counts through `npm view <name> dependencies`.
