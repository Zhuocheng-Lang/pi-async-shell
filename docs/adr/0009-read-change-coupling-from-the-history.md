# 0009. Read change coupling from the history, and treat an island as unproven

- **Status:** Accepted
- **Applies to:** 0.2.3
- **Supersedes:** none
- **Design:** `docs/design/04-runtime-architecture.md` §1

## Context

ADR 0008 read the import graph and concluded that the centre of this package did
not move: `registry.ts` kept twelve dependencies, `extension.ts` still reached
nineteen of twenty-two modules, and both are orchestrators rather than a tangle.
An import edge is a claim about what may need an edit. It is not a claim about
what a change cost. Two questions survived the split, and the matrix cannot
answer either:

- Was the real coupling on the registry side, with `extension.ts` a thin shell
  over it?
- Is `src/core/types.ts` — fan-in ten, the highest in the tree — a place where
  types are concentrated, or a contract that drags its consumers?

The history answers both, and it is short. Forty-one commits are reachable from
git HEAD, and that set is `jj log -r '::@-'` minus jj's virtual root: the same
commit ids, compared one by one. The working-copy commit `@` is excluded. It
carries a whole session as a single commit, so including it collapses every
module added in that session into one observation and destroys the statistic it
was supposed to join. Eighteen of the forty-one touch `src/`, seven of those
touch exactly one file, and two touch a large part of the tree: the commit that
imported the package (fifteen of twenty-two modules) and the split itself
(twelve). The matrix therefore rests on nine observations. This is a hypothesis
generator, not a measurement.

## Options

| Option | What it costs | Why it was not taken |
|---|---|---|
| Weight a pair by 1/(k−1) for a commit of k files, instead of dropping whole-tree commits | Counts stop being integers, and P(B\|A) stops meaning "in how many commits" | The only use a row has is that a reader can open the four commits behind it. A weight of 0.42 is not openable |
| Keep every commit and rank by Jaccard | Jaccard reports 1.00 for a pair whose only witness is the import | At `--max-share 1` the report fills with pairs the import and the split created: three pairs read n=3 where the incremental history holds one observation (`shell-policy` with `types`, `screen` with `extension`, `shell-policy` with `extension`) |
| Gate on an import edge for every strong pair | A statistic that moves with every commit becomes a merge requirement | Nine observations. The next commit would edit the history rather than the code |
| Treat a pair seen once as a finding | Nothing | Eight pairs have no direct import edge and every one of them is a single commit. One observation cannot separate a rule from a coincidence |
| Read fan-in zero in the DSM as independence | Nothing | `pipe-supervisor.mjs` and `recording-writer.mjs` have no import edge in either direction, and both change with the module that hands them their arguments |
| Report the matrix and cut nothing (taken) | A reader has to decide what a count means | The counts are printed with their own denominator, and each filter names itself when it fires |

## Decision

`scripts/cochange.mjs` mines the history at commit granularity and reports three
numbers per pair: how many commits touched both, the two conditional rates, and
the Jaccard coefficient. `pnpm cochange` runs it. It prints a report, enforces
nothing, and stays out of `pnpm verify` for the reason the DSM stays out: it is
an aid to reading, and a gate would need a sample this repository does not have
yet.

Three filters apply, and each one is printed when it fires. A one-file commit
makes no pair. A commit that touches more than thirty percent of the files in
scope is a restructuring and not a coupling observation, so it is listed and
excluded, and the threshold never falls below four files so that a small scope
keeps its commits. `--max-share 1` turns the filter off, which is how the cost of
keeping those two commits was measured. Generated files record what a tool
produced rather than what a person decided.

A pair seen once sits below the default threshold. Eleven pairs are at that size,
and every pair that has no import edge between the two files is one commit, which
cannot separate a rule from a coincidence. Every pair is also classified against the
import graph: structural when an edge exists either way, indirect when the two
files are two or three hops apart, hidden when they are disconnected, and outside
when either file is not in the import graph at all, which is what a test file is.

One rule follows for reading `dsm.mjs`: a module with fan-in zero is an island in
the import graph, and an island is not independent. The two modules this tree
shows as isolated are the two it runs as separate processes, and they receive
their whole state through `process.argv`. No import edge will ever appear between
them and the module that decides what to pass.

## Consequences

- **The strongest pair is `registry.ts` with `extension.ts`.** Four of the nine
  informative commits touched both, Jaccard 0.57. The direction is the opposite
  of the premise: when `extension.ts` changed, `registry.ts` changed with it in
  80.0% of commits, and the other way round in 66.7%. Neither is a thin shell
  over the other. They are one interface seen from two sides, which is why the
  next split has to cut across both and why `docs/rfcs/` owns it.
- **`types.ts` is a contract, not a type dump.** Each of its three informative
  commits also touched `extension.ts` or `registry.ts`, one each way and one both,
  so no edit to it stood alone. Fan-in ten describes the blast radius, not a tidy
  pile of declarations.
- **No hidden coupling survives two observations.** The four pairs that do have
  no import edge between them each come with a mechanism worth naming: `paths.ts`
  with `pipe-supervisor.mjs` (the runtime directory the supervisor opens files
  in, and the mode it opens them with), `spawn.ts` with `recording-writer.mjs`
  (the symlink the wrapper is launched through), and `ansi.ts` with `screen.ts`
  (the same escape grammar, parsed twice, once to strip and once to replay).
- **The end-to-end test moves with the tool surface.**
  `tests/extension-e2e.test.ts` and `src/extension.ts` co-change in seven of seven
  commits, at 100% in both directions, and ten of ten when the whole-tree commits
  are kept. Every change to the tool surface has carried an end-to-end change.
  Whether that is discipline or the size of the file is not something this matrix
  can say.
- **The matrix has a shelf life.** Rerun it when the history holds a few dozen
  informative commits. The script reads the whole history in about one second, so
  nothing about the choice depends on keeping it cheap.

## Evidence

`pnpm cochange`, scope `src/`, nine informative commits: `registry.ts` with
`extension.ts` n=4, P(B\|A) 66.7%, P(A\|B) 80.0%, Jaccard 0.57; `types.ts` with
`extension.ts` n=2, 66.7% and 40.0%, Jaccard 0.33; `registry.ts` with `types.ts`
n=2, 33.3% and 66.7%, Jaccard 0.29; eleven further pairs at n=1. Eight pairs have
no import edge between them, four of them disconnected.

`pnpm cochange --scope src,tests`: `extension.ts` with
`tests/extension-e2e.test.ts` n=7, 100% and 100%, Jaccard 1.00.

`pnpm cochange --max-share 1`: the same two pairs at n=6 and n=10, and three
pairs at n=3 that the incremental history holds once, all three manufactured by
the import and the split.

`node scripts/dsm.mjs --format json` names `src/core/pipe-supervisor.mjs` and
`src/core/recording-writer.mjs` with no edge in either direction, and
`src/core/paths.ts` and `src/core/spawn.ts` are the modules that hand them their
arguments: `process.argv.slice(2)` in both supervisors, and the
`recording-writer.mjs` symlink `spawn.ts` stages into the execution directory.
