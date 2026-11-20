# Changelog

All notable changes to pi-async-shell are documented here. The format follows Keep a Changelog, and versions follow Semantic Versioning.

## [Unreleased]

### Added

- `shell_start inlineSettleMs` (default `1000`). A command that settles inside the window returns its status, exit code and output tail in the start call itself, so a fast command costs one tool round trip instead of two and no `shell_await` follows. The settle is then not announced again as a completion message. A command that outlives the window keeps the handle it always returned and still announces its own completion. `0` restores the return-immediately behaviour. A trivial `pipe` command settles in about 50ms and a `pty` one in about 260ms in the end-to-end suite.
- `shell_start delivery: "steer" | "settle"`. A completion that lands while the agent is running is steered in before the next LLM call; `settle` holds it for the settle boundary.
- CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, issue and pull request templates, a CI workflow, and .editorconfig.
- `typescript`, `@types/node` and the three Pi host packages as pinned devDependencies. `pnpm install` now builds the whole toolchain, so `pnpm typecheck` and `pnpm test` no longer depend on a global `tsc`, a Pi installation or the `NODE_PATH` Pi exports.
- .node-version and .nvmrc, both pinning 22.19.0, the floor `engines` declares.
- .gitattributes, normalizing line endings and marking the generated lockfiles and benchmark results.
- A `prepublishOnly` script that runs `pnpm verify` before a publish.
- A CI matrix over Node.js 22.19.0 and the current release, plus a `pnpm pack --dry-run` step so the published file list is visible in every run.
- `engineStrict` in pnpm-workspace.yaml, which makes `engines.node` a hard install requirement instead of a warning.

### Changed

- Completion delivery steers while a run is in progress instead of holding every record for the settle boundary. The record now reaches the model before its next decision, and the prompt guidelines say so.
- The project license is MPL-2.0 instead of MIT. The change is forward-looking: releases up to and including 0.2.0-beta.1 stay MIT. Source files carry SPDX headers, and the npm tarball now ships CONTRIBUTING.md, CODE_OF_CONDUCT.md and SECURITY.md.
- pnpm replaces npm as the package manager. package.json pins pnpm 12.21.0 through packageManager, the verify script and every documented command call pnpm, and bench/vendors ships a pnpm-lock.yaml instead of a package-lock.json. pnpm-workspace.yaml turns off pnpm's pre-run dependency check, because the benchmark's symlinks would otherwise look like a stale install.
- The dev toolchain is declared instead of discovered. TypeScript 6.0.3, @types/node 22.20.5, @earendil-works/pi-coding-agent 1.5.2, @earendil-works/pi-ai 1.5.2 and typebox 1.3.27 are devDependencies locked in pnpm-lock.yaml; the host packages stay in peerDependencies with a `*` range, which is the Pi package convention.
- `tsconfig.json` turns on `checkJs`, so the shipped `src/core/pipe-supervisor.mjs` and `scripts/link-host.mjs` are type-checked. Annotating them needed no behaviour change; the supervisor's owner stream is now a local const so the narrowing survives into its callbacks.
- CI installs from the lockfile with `pnpm install --frozen-lockfile` instead of npm-installing the host packages into a temporary directory and a global TypeScript.
- `scripts/link-host.mjs` is now additive. It reports the host packages pnpm already installed, links only what is missing, and mirrors Pi's module store for the benchmark without touching a package pnpm manages. It is no longer part of the setup.
- pnpm-workspace.yaml uses `allowBuilds`. pnpm 11 removed `onlyBuiltDependencies` and `ignoredBuiltDependencies` in favour of it.

### Fixed

- `pnpm typecheck` failed from a clean checkout with `TS2688: Cannot find type definition file for 'node'`. `@types/node` was never declared; it only resolved because the dev machine's Pi installation happened to be linked into `node_modules`.
- `pnpm install` resolved the peer dependencies to whatever the registry served that day, including typebox 1.4.7 where Pi 1.5.2 ships 1.3.27. The host packages are pinned now.
- `pnpm install` failed with `ERR_PNPM_IGNORED_BUILDS` wherever pnpm's `strictDepBuilds` keeps its default of true, which includes CI. The two transitive install scripts are denied explicitly.
- `scripts/link-host.mjs` replaced packages pnpm had installed, and in a checkout with no `NODE_PATH` it could link a package to its own path. Both are fixed; the script is idempotent and skips anything the manifest declares.
- `pnpm install --dir bench/vendors` failed with `ERR_PNPM_IGNORED_BUILDS` under pnpm's default `strictDepBuilds`. The three install scripts in the vendor field are now denied explicitly in `bench/vendors/pnpm-workspace.yaml`, which leaves the benchmark environment exactly as it was when `bench/REPORT.md` was generated.
- `pnpm test` discovers the TypeScript test files on Node.js 22. `node --test tests/` matched no `.ts` files on the declared minimum version and failed with `MODULE_NOT_FOUND`; both test scripts now pass an explicit glob to the test runner, which discovers the same test files on Node.js 22.19.0 and 26.13.1.

## [0.2.0-beta.1] - 2026-11-17

### Added

- Lossless promotion of default pipe sessions to workspace scope through detached supervisors and an explicit fd 3 release protocol.
- A single readiness marker at $PI_ASYNC_SHELL_EXEC_DIR/ready and output-pattern waits through shell_await.
- Linux and procfs guards with explicit errors on unsupported systems.
- Automatic .pi/async-shell/.gitignore creation plus startup and hourly garbage collection for expired terminal records and orphan request keys.
- Default filtering of common credentials and API-key environment variables, with explicit shell_start.env overrides.
- A bundled async-shell skill for server, test, readiness, promotion, and PTY workflows.
- Publishing metadata and a dry-run-verified npm package layout.

### Changed

- Commands use /bin/bash -c by default, falling back to /bin/sh. Ambient $SHELL no longer selects a non-POSIX command interpreter; PI_ASYNC_SHELL is the explicit override.
- Both pipe scopes use detached, file-backed logging. The pipe log cap drains surplus output without killing or blocking the command.
- shell_await waitMs now defaults to 30000 and has a maximum of 50000 to fit codemode's 60-second default budget.
- Tool schemas and prompt guidance use the smaller session/workspace contract.
- Benchmark readiness is measured through shell_await output patterns, and bench/REPORT.md is regenerated.

### Removed

- scope turn, its agent_before_settle forced cancellation, and async-shell-error continuation injection.
- shell_start.readiness and the turn-only cancelOnFirstFailure option.

### Fixed

- shell policy is included in active prompt guidelines.
- Timeout and cancellation waits now observe finalized cleanup rather than premature terminal labels or supervisor exit records.
- Promoted executions retain durable metadata and workspace adoption links.

### Security

- Long-lived children no longer inherit common LLM keys, tokens, and credential variables by default.
- The local protected-paths integration covers shell_start commands and shell_send PTY input as well as bash redirections.

[Unreleased]: https://github.com/Zhuocheng-Lang/pi-async-shell/compare/v0.2.0-beta.1...HEAD
[0.2.0-beta.1]: https://github.com/Zhuocheng-Lang/pi-async-shell/releases/tag/v0.2.0-beta.1
