# Changelog

All notable changes to pi-async-shell are documented here. The format follows Keep a Changelog, and versions follow Semantic Versioning.

## [Unreleased]

### Added

- A Design Structure Matrix for the source tree, in `scripts/dsm.mjs` and `pnpm dsm`. It builds the import graph with no dependency, partitions it by strongly connected component so that a dependency sits below the diagonal, and reports propagation cost, feedback edges, longest chain and per-module fan-in, fan-out and reach. The tree it describes has 22 modules, 38 edges, a propagation cost of 11.4% and no cycle. It prints a report and enforces nothing; `docs/adr/0008-read-coupling-from-a-matrix.md` records why no analyser package was added for it, with the direct dependency counts that decided the question.
- A change coupling matrix over the history, in `scripts/cochange.mjs` and `pnpm cochange`. It reads which files each commit touched, counts the pairs, and classifies every pair against the import graph: structural when an edge exists either way, indirect when the two files are two or three hops apart, hidden when they are disconnected, and outside when either file is not in the graph at all. Three filters keep the counts readable — a one-file commit makes no pair, a commit touching more than 30% of the files in scope is a restatement of the tree rather than an observation (the import and the split, both listed in the output), and a generated file records what a tool produced — and `--max-share 1` is what shows they earn their place: keeping those two commits lifts three pairs to a count of three whose whole evidence they are. Over 41 commits, nine of them informative, the strongest pair is `src/core/registry.ts` with `src/extension.ts` (4 commits, Jaccard 0.57), and the direction is `extension.ts` pulling `registry.ts` in 80.0% of its commits against 66.7% the other way, so neither file is a thin shell over the other and the next split has to cut across both. Every one of the three `src/core/types.ts` commits touched one of those two, which makes its fan-in of ten a blast radius rather than a pile of declarations. Eight pairs have no import edge and every one of them is a single commit; the four that are disconnected from the graph each name a mechanism, and two of those are the modules `src/` runs as separate processes (`pipe-supervisor.mjs` with `paths.ts`, `recording-writer.mjs` with `spawn.ts`), which is why an island in the DSM is not independence. `pnpm cochange --scope src,tests` adds the test coupling, where `tests/extension-e2e.test.ts` and `src/extension.ts` changed in seven of seven commits, at 100% in both directions. It prints a report and enforces nothing; `docs/adr/0009-read-change-coupling-from-the-history.md` records the filters, the rejected weighting and the rule about islands.
- Add an `async-shell-maintainer` skill for development of the package itself. Keep the `async-shell` skill focused on consumer workflows, and record the routing and content boundary in `docs/design/06-skill-boundaries.md` and its Chinese mirror.
- Directed tests for the change coupling matrix, in `tests/cochange.test.ts`, and the split that makes them possible. The script keeps its output byte for byte — every table, note, section limit and payload key was captured before the refactor and diffed after it — but its stages are now exported, the stages that read git take the repository directory, and `buildReport` and `renderText` are named sub-stages instead of two functions of cyclomatic complexity 44 and 22. That is what a test can hold: the arithmetic (one co-change count in, P(B|A), P(A|B) and Jaccard out, and a one-file commit that makes no pair), the three filters (the size cap and its floor of four, a generated path recognised by its shape rather than by a list of names, a path deleted before the tip), the four classifications and the degradation to `outside` when the import graph cannot be read, and the argument contract down to the exit code the shell sees. A rename has no instance in this history — 41 commits carry no `R` line — so the test builds the two commits that would expose the bug: a `git mv` plus an edit to the other file, read back through the same code, where the alias rewrite is what makes the pair count twice instead of once. The end-to-end tests run against this history and allow it to grow, pinning the rank order, the pair the ADR leans on, and that every rate in the payload follows from the payload's own counts. `test:unit` runs the file, and the suite goes from 140 to 176 tests.

### Changed

- The two largest modules are split by change reason, not by layer. `src/core/registry.ts` (1628 lines) held five unrelated reasons to change, four of which were already leaves and moved out unchanged: `src/core/keys.ts` holds the key table, `src/core/utf8.ts` holds the window boundary that the log reader and the registry's delta poll both need, `src/core/records.ts` holds atomic JSON, log deltas, the stdin FIFO and a replay key's file name. `src/extension.ts` (1363 lines) held every string a person or a model reads back, so a wording change sat at the top of the graph; that is now `src/presentation.ts`, which imports types and nothing else and takes the one method it needs (`LogReader.read`) instead of the registry that happens to have it. `registry.ts` is 1450 lines and `extension.ts` is 1249, their share of `src/` falls from 52% to 45%, propagation cost falls from 13.3% to 11.4%, and reading bytes out of a log no longer depends on the terminal replay model. The centre did not move: both files still orchestrate 12 and 7 dependencies, and splitting them further needs an explicit context object instead of today's closures, which `docs/rfcs/` owns.
- The terminal geometry has one declaration. `PtySize`, its bounds and its clamp live in `src/core/types.ts`, the `pty-size` record is written and read by `src/core/spawn.ts`, and the screen model clamps with the same numbers. Three copies of "20-500 columns, 4-200 rows, 80x24 default" are how a child and a replay end up disagreeing about the width while the note reports the replay's own default as the terminal's size. `readPtySize` returns `undefined` for a record it cannot read, and the note then says the default was assumed.
- `shell_send` reports the viewport through the same path as `shell_read`. It re-entered the public `read` with `mode: "tail", lines: 80`, which tied the write path to a tool-facing mode, note and range it discarded, and asked for a line count no viewport has.
- Assign each prompt guideline to its owning tool. Move shell policy and parameter behavior into tool descriptions and parameter schemas. Remove repeated guidance and internal lifecycle names from model-facing text.

### Fixed

- `shell_read` with `stream: "ptyView"` no longer reports a viewport it could not reconstruct as an empty screen. The replay covers the tail of the recording and could only start at a newline, so a program that redraws with `\r` and never writes one — a progress bar is the ordinary case — was replayed from nothing: 348 890 bytes of output answered `text: ""`, `truncated: false`, and a note that said only "rendered 80x24 terminal screen". The window now aligns on a carriage return as well, a windowed replay reports `truncated`, the note names the window, and a window with no boundary at all says the viewport could not be reconstructed and points at `combined`.
- A `mode: "all"` `ptyView` read no longer offers a next page. Its range reported `nextByte` equal to the file size and `nextLine` counting viewport rows, so following the note's advice to page with them jumped straight to EOF. A screen read now omits `nextByte` and `nextLine` and says the viewport is not pageable; a byte stream keeps the note and the offsets unchanged.
- A `ptyView` read says which terminal it replayed at. The geometry came from a `pty-size` parse that fell back to `{}` on any failure, and the screen model then rendered at its own 80x24 while the note presented that as the terminal's size: at `COLUMNS=200` a 150-character line wrapped in two where the child saw one. The size now comes from the record's owner, and an unreadable record is reported as assumed.
- An SS3 sequence is consumed instead of printing its final byte. `ESC O` was treated as an unknown two-byte escape, so `ESC O P` left the `P` in the grid: an echoed F1 reached the screen as a stray letter, and `keyToBytes` emits exactly that form for `f1` to `f4`.
- A single-shot `pi -p` or `pi --mode json` run no longer reaps a `session` execution before its completion can continue the run. Those modes dispose the session as soon as the prompt settles, so a command started and then left to wake the agent was cancelled by `session_shutdown` at exit: the wake-up the agent was waiting for could not arrive. `agent_before_settle` now holds that boundary for every live, unready `session` execution with `notifyOnCompletion` and `triggerOnCompletion` enabled, and injects the settled records as one boundary message with `continue: true`. The hold only observes: the registry's completion channel still delivers, so an execution is announced once and `consumedByAwait` stays false. Readiness ends the wait as surely as exit, which keeps a companion service with a ready marker from holding the host open, and executions with either option false hold nothing at all. Final `session_shutdown` still reaps them, because work that must outlive the run is `scope: "workspace"`. Resident `tui` and `rpc` sessions keep the behaviour they had. `ShellRegistry.awaitHandles` takes the delivery decision as an internal option rather than a tool parameter, and the `shell_start` scope parameter description, the `async-shell` skill and both design series state which executions hold a single-shot run open.

## [0.2.3] - 2026-11-26

### Added

- The Quint checker is a pinned development dependency, and `pnpm run spec` runs it. `npx @informalsystems/quint@latest` named no toolchain: the version behind it changes between machines and between days, so "the model checks clean" was a claim about whatever the registry served. `@informalsystems/quint@0.34.0` is now in `devDependencies` and locked, and `spec:typecheck`, `spec:run` and the `spec` script that runs both expand to `pnpm exec quint …`. The pinned version was validated before it was pinned: `typecheck` reported nothing and `run --max-samples=5000 --max-steps=20 --invariant=invariants` reported `[ok] No violation found`. The install needed no supply-chain exclusion — the lockfile passed pnpm's policy check unchanged — and no new `allowBuilds` entry, because the checker declares no `preinstall`, `install` or `postinstall` script and the `protobufjs@7.6.6` it depends on is the version the root list already denies. It also installs no evaluator: the `rust` backend of `quint run` fetches one into `~/.quint/` on first use, which is one reason the three scripts stay out of `pnpm verify` (`spec/README.md`, `CONTRIBUTING.md`).

### Changed

- A `pty` recording is bounded by the same cap as a pipe log. `script(1)` wrote `combined.log` itself, so the file grew for as long as the terminal ran; the recording now passes through `src/core/recording-writer.mjs`, which keeps reading, appends at most `PI_ASYNC_SHELL_MAX_LOG_BYTES`, drops the rest and writes `log-cap.json`. util-linux's own `--output-limit` was measured first and rejected: it ends the session at the limit, so a full log would have become a failed command. The retained bytes are the beginning of the recording, which is what keeps the cached byte offsets in the line index valid; after `capReached`, a tail read describes the end of that prefix (ADR 0007).
- `shell_promote` `to` accepts `workspace` alone, and omitting it performs the same move. `to: "session"` was an accepted no-op write on a session execution and a refusal on a workspace one, so the only other value the type offered was the one direction the model forbids. The schema now offers `workspace`, the registry refuses `session` with the reason, and a repeated `shell_promote` on a workspace execution still returns its handle unchanged (ADR 0006).
- Tool parameters are typed from their own schemas. Seven handlers forwarded `params as never` into registry methods typed with the `Shell*Params` types, which is where a schema that drifted from the registry would have gone unnoticed. `StringEnum` now returns a schema whose TypeBox static type is the literal union, carried by a hidden `~` property, so the JSON that reaches the model is byte-identical; `agent_before_settle` builds `SessionBoundaryDraft[]` instead of casting its result. `src/extension.ts` contains no `as never`.
- The benchmark vendor manifest pins all eight competitors. `pi-background-tasks` was read from the machine's global Pi store, so the field depended on whatever that machine happened to have installed; it is now `pi-background-tasks@2.6.10` in `bench/vendors`, loaded through the entry the package declares for itself. `bench/vendors/pnpm-workspace.yaml` also rewrites the three `file:` subdependencies that `pi-exec-command@0.3.10` publishes, which pnpm 11.29 and later refuse with `ERR_PNPM_LOCAL_SUBDEP_NOT_ALLOWED`; each override names the version the tarball already bundles, so the installed code is unchanged.
- `bench/REPORT.md` is a run of the current code, generated 2026-11-25 against `@earendil-works/pi-coding-agent@1.6.0`. The previous report was dated 2026-11-17, before `inlineSettleMs` and before pipeline status, and both READMEs and §5 of the implementation notes quoted it. It was regenerated when the Pi host packages moved to 1.6.0, because the harness loads the SDK that `devDependencies` pins, and a report whose environment block named 1.5.2 would have described a toolchain no checkout installs. The environment block records the SDK versions that were actually loaded, which are not the `pi` on `PATH`, and the load average at the start of the run, because admission latency follows machine load: this run measured a 5.8 ms median at a load average of 2.79, and the run before it measured 6.5 ms at 3.74. Every number in `bench/REPORT.md`, both READMEs and §5 comes from this one run.
- Nearly every tool argument carries a `description`. `binding`, `scope`, `keys`, `request`, `graceMs` and the read offsets could only be inferred from the prose guidelines, so a caller had to read 14 KB of them to learn what a parameter accepts.
- The documentation no longer claims a `protected-paths` integration this package does not contain. The hook belongs to the local Pi configuration, it covers the `bash` tool alone, and `SECURITY.md` listed it as a guard this package provides. Both READMEs also counted the benchmark field as nine extensions while the report, the commit and `implementation-notes.md` §5 count eight, and the comparison table left out the two rows where `pi-patty-bg-tasks` matches or beats this package. §5 now quotes the committed run's numbers instead of a different run's.
- The prompt guidelines and the bundled skill ask whether a later action depends on the external state before any wait starts. Nothing here wakes a turn for a bare condition, so the earlier shape of the rule — start one watcher that exits when the state changes, end the turn — invited a watcher for a refresh that no later action needed, such as a registry index after a publish that had already succeeded. The rule now says to report what is verified and stop in that case, and to start one watcher only when a later action depends on it, await it once, then end the turn. The skill also tells a `codemode` caller to read `settled`, `timedOutWaiting` and `note`, not `outcomes` alone.
- `devDependencies` is the whole toolchain and every entry is an exact version. `typescript`, `@types/node` and `fast-check` carried caret ranges, which left `package.json` and `pnpm-lock.yaml` disagreeing about what an install produces; the ranges became the versions the lockfile already resolved, so a toolchain bump is a manifest edit, an install and a lockfile change in one commit. The audit found nothing to remove and nothing to declare: `typebox`, imported by `src/extension.ts`, and `fast-check`, imported by `tests/properties.test.ts`, were both already direct entries rather than hoisted ones, and `vale` and `lychee` stay off npm because they are documentation gates that do not belong to this package's install. The two entries that do duplicate a dependency stay: `@earendil-works/pi-ai` and `typebox` arrive through `@earendil-works/pi-coding-agent`, but `autoInstallPeers` fills an undeclared peer from its `*` range, so removing either resolves the peer to the newest release — a fresh resolution of this manifest without the `typebox` pin installs 1.4.7 against the 1.3.27 Pi ships. Each of the seven entries resolves to one version in the tree, at the pin, and every name that appears at more than one version is transitive, where different consumers require different majors. The Quint tree is the one real cost, and its `chalk@4` also gives the Pi host packages a second `supports-color` peer variant, so their lockfile entries re-resolve at the same version. The pins then moved to the newest versions the release-age policy allows: `typescript` 7.0.2, the native compiler, whose `tsc --noEmit` and full suite pass unchanged; `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` 1.6.0, the release the `pi` on `PATH` runs, where 1.5.2 was what the old pins resolved; and `fast-check` 4.11.0. Two entries deliberately did not move. `@types/node` stays at 22.20.5 rather than 22.20.6, which was published hours before this change and still sits inside the release-age window pnpm enforces, so taking it would have cost a policy exclusion for a patch bump; and `typebox` stays at 1.3.27, the version `@earendil-works/pi-coding-agent@1.6.0` itself depends on, because the dev copy exists to be the same module Pi supplies. Together, the install went from 128 to 207 packages and `node_modules` from 324 MB to 375 MB on this machine. `.vscode/settings.json` no longer sets `typescript.tsdk`: it pointed at `node_modules/typescript/lib`, which held `tsserver.js` under 6.0.3 and holds only `tsc.js` under 7.0.2, so the editor falls back to its own TypeScript and `pnpm typecheck` stays the check of record.
- `bench/probe-tools.ts` probes the field `bench/impls.ts` pins instead of its own list of packages. That list had drifted both ways: it named `pi-process-monitor` and `@alignfirst/pi-background`, which the report records as probed and dropped, and it did not name `pi-exec-command`, which the report measures. A vendor directory name as an argument still probes a candidate before it joins the field, so the use the list was written for survives. `bench/README.md` documents the probe, which nothing else mentioned.
- `src/core/pipe-supervisor.mjs` carries the SPDX header the other fourteen sources under `src/` carry. It was the only file a license grep missed, and the header is the whole change.

### Fixed

- The changelog record for `0.2.0-beta.1` said the version was never published. The registry says otherwise: `npm view pi-async-shell time` carries `0.2.0-beta.1` at 2026-11-20T08:28:53Z, and its tarball still downloads. The staged upload reported itself wedged, and the version was published minutes after the `0.0.0-stage` placeholder that the staged flow leaves behind.
- `shell_start` and `shell_await` put their note in structured content as well as in the text result. A `codemode` script reads `structuredContent`, so a clamped `waitMs` or `inlineSettleMs`, and the end-the-turn guidance after a full-length wait, never reached it: the wait looked bounded for no stated reason, and the instruction that follows a full-length wait was lost.
- A settle that `shell_await` reports is no longer announced a second time, including while the call still waits on another handle. The settle reaches the completion channel before the await can observe it, so every awaited run also produced a completion message, and a caller that already read the outcome paid for the same result twice. A wait now claims the ids it reports before it waits, which holds their records instead of announcing them: the call consumes the terminal outcomes it delivers, and hands anything it did not report back to the completion channel. An aborted call claims nothing, because its outcome may never reach the model, and a workspace record that an await consumed is no longer surfaced at the next `session_start`.
- A `pty` command keeps the signal dispositions it started with. `script(1)` now runs in the foreground of the wrapper, so SIGINT and SIGQUIT are no longer `SIG_IGN` inside the recorded terminal. POSIX sets them to ignored in the child of an asynchronous list and a non-interactive shell cannot reset what it inherited as ignored: on a host whose `/bin/sh` is `dash`, which is Debian and Ubuntu, `^C` reached the line discipline and the recording but never the foreground process group, and a graceful cancel could only wait out `graceMs` and escalate. Only the owner watcher is asynchronous now, it stops on SIGKILL rather than on the signal that means owner loss, and the wrapper traps SIGTERM so a group signal cannot take it down before it seals `exit.json`.
- A `pty` starts in a workspace whose path contains a space. The launcher path travels in `PI_ASYNC_SHELL_EXEC_DIR` instead of being pasted unquoted into `script -c`.
- `shell_read` and `shell_await` agree on what a `pty` records. `stderr` used to name an empty file: a read returned nothing and a pattern wait spent its whole budget on a file that cannot grow. Both map the request onto `combined` and say so in the note.
- Two `request` keys that sanitize alike stay two executions. `"build one"` and `"build/one"` both reduced to `build_one`, so the second `shell_start` returned the first handle and never ran its command while reporting success. A key the sanitizer changed now carries a digest of the exact string, and the record's tool is part of its name, so a start record cannot answer for a keystroke.
- `shell_send` `keys` accepts the spellings the documentation uses — `Ctrl+C`, `ctrl c`, `CTRL+C`, `PageUp`, `F5` — and refuses a name it does not know. An unknown name used to be written as literal text and reported as `wrote: true`, which reads as a delivered keystroke the program ignored.
- `shell_cancel` and both READMEs say "no tracked process survived" instead of "tree verified gone". The fence unions three views — environment tag, ppid tree, owned process groups — and a child that calls `setsid(2)` between scans stays out of reach, so the prose now claims exactly what the check delivers; the structured field keeps the name `verifiedGone`, and a leaked pid is still reported as a leak.
- A record write that fails inside `finalize` reports a diagnostic instead of raising an unhandled rejection. A full disk, a removed record directory or a permission change took the whole Pi process down, and with it every other execution.
- `shell_read` `mode: "grep"` and `shell_await` `until.kind: "pattern"` match a character that straddles a read chunk. The scan decodes through `StringDecoder` and the wait's delta read stops on a character boundary, so a line holding a multi-byte character is no longer invisible to a pattern that spans the boundary.
- A pattern that can backtrack catastrophically is refused before it runs. The source is limited to 512 characters and a quantifier applied to a group that already repeats is rejected. The match still runs on the main thread, so §4 of the implementation notes records this as a floor.
- `shell_cancel` `graceMs` is clamped to 30000 like every other wait, and an empty `sessions/<id>-<pid>/` directory is collected once it is older than the retention window. A process that never ran a command left its directory behind for good, and every workspace scan walked it.

### Removed

- `LogWriter`, `processTreeSize` and `allProcessCount`. The first duplicated the pipe supervisor's cap logic and had no caller; the other two had none either.
- The duplicate 250 ms log poll. The exit watcher already ran the same refresh, readiness check and UI update on the same interval.

### Security

- `.pi/async-shell` and its subdirectories are created `0700`, the stdin FIFO `0600` and the log files `0600`. `SECURITY.md` already lists another local user reading a pty recording or writing to a stdin FIFO as in scope, and the default umask did neither.

## [0.2.2] - 2026-11-23

### Fixed

- The manifest declares `pi.image`, so the [Pi package gallery](https://pi.dev/packages/pi-async-shell) shows the project icon instead of the placeholder frame. `0.2.1` shipped `docs/assets/logo.png` but never pointed the manifest at it, and the gallery reads that field alone, so the icon stayed unsynced even though the file was public. `tests/manifest.test.ts` keeps the field on an absolute `https` URL and resolves a `raw.githubusercontent.com` preview back to a file in the checkout.

## [0.2.1] - 2026-11-22

### Added

- A project icon drawn in the Earendil Works house style. `docs/assets/logo.svg` pairs the `pi.dev` Evening Blue slate (#161D27) and Tidal Blue frame (#4B607C) with the Elanor Coral Red (#F09082) stepped prompt, the Cerulean Blue (#4D9ABF) session stream and the Cream Yellow (#F1BE58) readiness block, and the 62%/38% active stripe reproduces `pi.dev`'s `--active-stripe`. `docs/assets/logo-glyph.svg` is the frameless tri-color variant, `docs/assets/favicon.svg` follows the `pi.dev` `prefers-color-scheme` monochrome convention, and `docs/assets/logo.png` is the 512px export. Both READMEs now open with the icon, matching the `earendil-works/pi` layout.

## [0.2.0] - 2026-11-22

The version number stops being a prerelease, so npm's `latest` points at it and tooling treats it as a normal release. The project is still pre-1.0: a minor version may change the API, and the README says so.

### Added

- `shell_read` accepts `mode: "all"` as a bounded head read (2000 lines / 50 KiB) with paging guidance in the note.
- Pipeline commands record `exitSource`: `pipefail` on bash-like shells, `last-command` on the POSIX fallback. Completion messages and await results include exit codes and bounded output excerpts.
- A documentation toolchain. `scripts/check-docs.mjs` checks the cross-references, the bilingual mirror, the frontmatter version, the `Evidence:` test titles and every tool name, and it needs nothing but Node. Vale enforces the retired vocabulary of `00-terminology.md` section 10, lychee checks relative links and anchors, and both run in a separate CI job.
- `docs/adr/` holds decisions in MADR format, `docs/rfcs/` holds proposals, and `spec/handle-lifecycle.qnt` models the completion and promotion contract in Quint. ADR 0001 to 0004 backfill the decisions the design series had been carrying as history.
- The design series opens with frontmatter naming the version it applies to and the sources it tracks, and `tests/properties.test.ts` adds property tests over the ANSI stripper, the screen model and the log reader. `fast-check` is a devDependency.

### Changed

- `CONTRIBUTING.md` requires [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). The commits before it were reworded to match, which changes their hashes without changing a single tree.
- `pnpm verify` now runs the document contract check after the test suite. `pnpm run docs` adds the two gates that need a binary, and CI runs all three as its own job.
- `docs/design/03-execution-model-and-primitives.md` documents `shell_read` `mode: "all"`, which the runtime has accepted since this release, and `docs/design/04-runtime-architecture.md` names `carrier` as code and calls the absent `shell_start` parameter a readiness option.

### Fixed

- `shell_await.waitMs` and `shell_start.inlineSettleMs` accept values above their practical caps and clamp them in the handler with a visible note instead of failing schema validation.
- Bash-like shells launch pipeline commands with `set -o pipefail`, so a failing stage no longer hides behind a successful `tail`.
- An aborted inline-settle call no longer consumes the completion; the notification channel still reports the execution.
- The publish workflow treats a version the registry already has as done. Rewriting the history moved `v0.2.0-beta.3` to the reworded commit without changing a tree, GitHub reported the re-push as a new tag event, and npm answered the second upload of that version with a 403, so the release run went red for a release that had already shipped. The job now reads the version from the registry over HTTPS, which no credential can hide, and uploads only when the version is absent.

### Security

- The design survey cites `~` rather than an absolute home path, and the benchmark resolves Pi's global package store from the home directory, with `PI_GLOBAL_NODE_MODULES` as the override. Both had published a local account name, in the docs and in the history that carried them, and that history is rewritten.

## [0.2.0-beta.3] - 2026-11-20

### Changed

- `publishConfig.tag` is gone. npm honoured it while pnpm ignored it, so a manual `npm publish` went to `beta` and a `pnpm publish` went to `latest`. npm now refuses a prerelease without an explicit `--tag`, which is the honest failure; the release workflow always passes one.

## [0.2.0-beta.2] - 2026-11-20

### Added

- `PI_ASYNC_SHELL_COALESCE_MS` sets the window in which settles merge into one completion message. The default stays 150 ms; `0` sends every settle on its own.
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

_Published. This note said the opposite, and the registry disagrees: `npm view pi-async-shell time` records `0.0.0-stage` at 2026-11-20T08:25:45Z and `0.2.0-beta.1` at 2026-11-20T08:28:53Z, and the tarball still downloads. The staged upload reported itself wedged (npm/cli#9889), yet it landed three minutes after the placeholder. `0.0.0-stage` is that placeholder, 365 bytes with `"stub": true` and no code in it, not a release. `0.2.0-beta.2` followed with the same tree: the two tarballs differ only in `package.json` and `CHANGELOG.md`._

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
- `shell_start.readiness` and the turn-only `cancelOnFirstFailure` option.

### Fixed

- shell policy is included in active prompt guidelines.
- Timeout and cancellation waits now observe finalized cleanup rather than premature terminal labels or supervisor exit records.
- Promoted executions retain durable metadata and workspace adoption links.

### Security

- Long-lived children no longer inherit common LLM keys, tokens, and credential variables by default.
- The `protected-paths` extension in the local Pi configuration covers `bash` redirections. It is a local extension and never covered this package's commands, which spawn through their own supervisor.

[Unreleased]: https://github.com/Zhuocheng-Lang/pi-async-shell/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/Zhuocheng-Lang/pi-async-shell/releases/tag/v0.2.3
[0.2.2]: https://github.com/Zhuocheng-Lang/pi-async-shell/releases/tag/v0.2.2
[0.2.1]: https://github.com/Zhuocheng-Lang/pi-async-shell/releases/tag/v0.2.1
[0.2.0]: https://github.com/Zhuocheng-Lang/pi-async-shell/releases/tag/v0.2.0
[0.2.0-beta.1]: https://github.com/Zhuocheng-Lang/pi-async-shell/releases/tag/v0.2.0-beta.1
