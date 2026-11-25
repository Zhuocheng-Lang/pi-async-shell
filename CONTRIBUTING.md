# Contributing to pi-async-shell

pi-async-shell is a Linux-only Pi extension that supervises shell executions. It is deliberately narrow: seven tools that start, wait on, read, promote, write to, cancel and inspect shell handles. It does not spawn agents, run multi-model workflows, or attach a human terminal. A change that widens that scope needs an issue first.

Issues, pull requests and reviews are welcome in English or Chinese.

## Requirements

- Linux. The runtime reads procfs, and the `pty` binding uses `script(1)`, `mkfifo(1)` and `stty(1)`.
- Node.js 22.19.0 or later. `.node-version` and `.nvmrc` pin that floor, and CI runs it alongside the current release. The test suite runs `.ts` files directly through Node's built-in type stripping.
- pnpm 12.21.0, the version pinned by `packageManager` in `package.json`. pnpm installs that version for you when the one on `PATH` is older.

Nothing else. The type checker, the property-test library, the Quint checker and the Pi host packages are devDependencies, so no global `tsc`, no global `quint` and no Pi installation are needed to run the suite.

## Set up

```sh
git clone https://github.com/Zhuocheng-Lang/pi-async-shell.git
cd pi-async-shell
pnpm install
pnpm verify
```

`pnpm install` is the whole setup. It installs `typescript`, `@types/node`, `fast-check`, `@informalsystems/quint` and the three Pi host packages at the versions the suite is verified against. Every `devDependencies` entry is an exact version rather than a range, and `pnpm-lock.yaml` records it: so a toolchain bump is a manifest edit, an install and a lockfile change in one commit. A package earns a `devDependencies` entry only when this repository runs it. Two of the entries look redundant and are not: `@earendil-works/pi-ai` and `typebox` both arrive as dependencies of `@earendil-works/pi-coding-agent`, and both are declared anyway, because `autoInstallPeers` fills an undeclared peer from its `*` range. Drop `typebox` and a fresh resolution installs 1.4.7 where Pi ships 1.3.27, which is the drift `0.2.0` fixed; the declaration is what makes the type checker, the tests and the benchmark read the module Pi supplies. That pin follows the host: when `@earendil-works/pi-coding-agent` changes the `typebox` version it depends on, the `typebox` devDependency changes in the same commit, which `npm view @earendil-works/pi-coding-agent@latest dependencies.typebox` answers in one line. `vale` and `lychee` are the counter-example and stay out: they are documentation gates that many other repositories use at other versions, and a contributor who has them on `PATH` does not need this package to install them.

The host packages are also declared in `peerDependencies` with a `*` range, which is the Pi package convention: Pi maps those imports to its own copies at runtime and never installs them from a manifest. The devDependency copies exist so the type checker, the tests and the benchmark import the same modules Pi would. Bumping them is a deliberate act: change `devDependencies`, run `pnpm install`, run `pnpm verify`, and commit the lockfile change with the bump.

`scripts/link-host.mjs` is not part of the setup. It is only needed for the benchmark, where it mirrors Pi's flat module store into `./node_modules` so a third-party extension can be loaded outside Pi. It never replaces a package pnpm manages.

`pnpm-workspace.yaml` holds the pnpm settings. `engineStrict` turns `engines.node` into a hard install requirement, so an older Node fails at install rather than inside the supervisor. `verifyDepsBeforeRun` is off because the benchmark's symlinks would otherwise look like a stale install and get pruned. `allowBuilds` denies the two transitive install scripts in the tree, which is what keeps `pnpm install` non-interactive under pnpm's default `strictDepBuilds`.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Installs the dev toolchain from `pnpm-lock.yaml`. |
| `pnpm verify` | `pnpm typecheck`, then the full test suite, then the document contract check. Run this before every pull request. |
| `pnpm typecheck` | `tsc --noEmit` over `src/` (including the shipped `.mjs` supervisor), `tests/`, `bench/` and `scripts/`. |
| `pnpm test` | The full suite, one test file at a time. |
| `pnpm test:unit` | Only the `tests/*.test.ts` files. |
| `pnpm link-host` | Mirrors Pi's module store into `./node_modules` for the benchmark. |
| `pnpm bench` | Regenerates `bench/out/results.json` and `bench/REPORT.md`. |
| `pnpm run spec` | Type-checks the Quint model under `spec/` and simulates it: `spec:typecheck` then `spec:run`. `pnpm verify` does not call it. |
| `pnpm pack --dry-run` | Lists the files the published tarball would contain. |
| `pnpm run check:docs` | The document contract check. Node only, no binary. |
| `pnpm run docs:prose` | Vale over `docs/`. Needs `vale` on `PATH`. |
| `pnpm run docs:links` | lychee over the documentation set, offline. Needs `lychee` on `PATH`. |
| `pnpm run docs` | All three documentation gates. |

The suite starts real processes and a real Pi SDK session driven by a faux provider. It needs a Linux machine with a writable `/tmp`; it needs no network access.

## What a change needs

- **A test that fails before the change.** The suite asserts on real process behaviour, so a fix without a test is a fix nobody can regress. `tests/helpers.ts` has `tempCwd`, `makeRegistry` and `waitFor`.
- **A changelog entry** under `[Unreleased]` in `CHANGELOG.md`, using the Keep a Changelog sections: Added, Changed, Removed, Fixed, Security.
- **Both READMEs** when a user-visible behaviour changes: `README.md` and `README.zh-CN.md`. They are maintained in parallel; a change to one is a change to the other.
- **Runtime documentation** in `docs/implementation-notes.md` when the mechanics change, an edit to the `docs/design/` series when the design changes, and an ADR in `docs/adr/` when a decision has a trade-off worth recording. The next section says which file takes what.
- **No new runtime dependencies.** The package ships with none and imports only the host packages Pi supplies. A new dependency needs a strong argument in the pull request.
- **The tool surface stays at seven.** A new tool needs an issue that explains what the existing seven cannot express.

## Code conventions

- TypeScript ES modules with `module: NodeNext`. Relative imports keep the `.ts` extension: `rewriteRelativeImportExtensions` handles the emit side and Node's type stripping handles the runtime side.
- `strict` is on and the type checker must pass. `noEmit` is set, so `tsc` is a checker here, not a build step.
- `checkJs` is on, so the two `.mjs` files under `src/` and `scripts/` are type-checked along with the `.ts` sources. Annotate them with JSDoc rather than loosening the config.
- No code linter or formatter is configured; that is a deliberate choice, not an omission. The one lint in this repository is prose-only and covers `docs/`; the next section says why. Match the surrounding style: two spaces, double quotes, semicolons, trailing commas in multiline literals. `.editorconfig` and `.gitattributes` keep indentation and line endings consistent across editors.
- Comments explain why a decision was made. The runtime has several deliberate oddities — the fd 3 release protocol, `trap - INT QUIT` before `exec`, the wrapper-side `exit.json` — and each one has a reason that outlives the code.
- Runtime state belongs under `.pi/async-shell/`. Never write it into the repository root.

## Documentation

`docs/` has four gates. They answer different questions, and two of them need something beyond `pnpm install`.

| Gate | Command | Needs | Question |
|---|---|---|---|
| Doc contract | `pnpm run check:docs` | Node | Do the cross-references resolve, do the two languages match, does the frontmatter name the current version, do the `Evidence:` test titles exist, is every tool name real |
| Prose lint | `pnpm run docs:prose` | `vale` on `PATH` | Does new prose use a word that `00-terminology.md` section 10 retires |
| Link check | `pnpm run docs:links` | `lychee` on `PATH` | Does every relative link and every `#anchor` resolve |
| Model | `pnpm run spec` | The pinned `@informalsystems/quint`, and its evaluator on the first run | Does an ownership or delivery invariant survive an interleaving nobody wrote a test for |

`pnpm verify` runs the first one, because it needs nothing but Node. CI runs the three that `pnpm run docs` assembles — contract, prose and links — as a separate `docs` job.

The model stays out of both. A run of `quint run` is a random walk with no fixed trace to assert on, so its verdict is a fact about one seed rather than a gate a commit can pass, and its default backend downloads an evaluator on first use. It belongs to the change that edits the contract: run `pnpm run spec` as `spec/README.md` describes, read the trace or the clean result, and record the conclusion with the change. Run `pnpm run docs` when you touch `docs/` and you have the two binaries; run `pnpm run check:docs` otherwise, and let CI do the rest.

### Which file takes what

| The change | Where it goes |
|---|---|
| What the design is now | `docs/design/`, in both languages, in the same pull request |
| Why a rule exists, or what it replaced | `docs/adr/`, a new number. An accepted ADR is never edited |
| A design that is not decided yet | `docs/rfcs/` |
| What the code does, and how it is tested | `docs/implementation-notes.md` |
| A contract worth modelling | `spec/` |

### Rules the design series follows

- **Frontmatter on every file.** `applies_to` must equal the version in `package.json`, so a version bump names the documents that owe an edit. `tracks` lists the sources the document describes.
- **A past version is marked.** A version literal that records history ends its line with `<!-- historical -->`. Any other mismatch fails the contract check, which is what keeps a stale number from surviving a release.
- **`zh-CN/` mirrors `docs/design/`** file for file, with the same heading skeleton, the same fenced blocks, the same table shape and the same code identifiers. Prose differs; code does not.
- **Cross-references are written for a checker.** Use `` `04-runtime-architecture.md` §6.2 `` rather than a bare "see above". A reference only a reader can follow is a reference that rots silently, which is what the four gates exist to prevent.

## Benchmarks

`bench/REPORT.md` is generated. Do not edit it by hand.

```sh
pnpm link-host
pnpm install --dir bench/vendors
pnpm bench
```

`--quick`, `--only=<impls>` and `--render-only` speed up iteration; `bench/README.md` lists them. Regenerate the report when a change affects a benchmark claim, and include the regenerated report in the same pull request.

## Commits and pull requests

- One concern per pull request. Keep unrelated formatting and renames out of a fix.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): a `type(scope): subject` header, where the type is one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` or `revert`, the scope is optional and lowercase, and the subject is imperative, lowercase and has no trailing period. `fix(shell_read): clamp the log cap to the header line` shows the shape.
- A breaking change carries `!` before the colon and a `BREAKING CHANGE:` footer. Release commits read `chore(release): 0.2.0`.
- Describe what changed, why, and what you ran. Paste the failing output when the change fixes a bug.
- CI runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` and `pnpm pack --dry-run` on Linux, on Node.js 22.19.0 and on the current release. A pull request that leaves CI red will not be merged.

## Licensing of contributions

Contributions are accepted under MPL-2.0, inbound = outbound. There is no CLA and no copyright assignment: you keep the copyright in what you write, and you license it to everyone under the project license.

New source files under `src/` start with:

```ts
// SPDX-FileCopyrightText: 2026 <your name>
// SPDX-License-Identifier: MPL-2.0
```

Do not paste code that cannot be licensed this way. If a change needs a third-party snippet, say so in the pull request and record its license.

## Reporting

- Bugs and feature requests: open an issue. The templates ask for the version, the platform, the tool calls and the relevant `shell_read` output.
- Security problems: follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
- Conduct problems: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
