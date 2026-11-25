# The benchmark

`bench/REPORT.md` is generated. Do not edit it by hand; run the benchmark.

```bash
pnpm install                        # the dev toolchain, including the Pi host packages
pnpm link-host                      # mirror Pi's module store into ./node_modules
pnpm install --dir bench/vendors    # install the pinned competitor field
pnpm bench                          # writes bench/out/results.json and bench/REPORT.md
```

Useful flags:

| flag | effect |
|---|---|
| `--quick` | three admission samples instead of ten |
| `--only=async-shell,bg-tasks` | run a subset of the field |
| `--render-only` | re-render `REPORT.md` from the last `results.json` |

`node bench/probe-tools.ts` is a manual probe, not a gate. It loads one
extension at a time and prints the tools and the parameter names each one
registers, which is where the capability matrix in `bench/REPORT.md` came from
rather than a package's README. With no argument it walks the field `impls.ts`
pins; with vendor directory names it probes a candidate that is not in the field
yet, which is how `pi-process-monitor` and `@alignfirst/pi-background` were
judged and dropped. The output also lands in `bench/out/tool-surface.json`.

## What is measured

Every implementation is loaded alone into a real Pi SDK session and driven by
calling its registered tools directly, so model latency is out of the numbers
while the code path a model would reach stays in. `bench/adapters.ts` holds one
adapter per implementation; each parses the tool results that implementation
actually returns, and `bench/impls.ts` pins the package and version.

Two scenarios run out of process, because the question is what happens when the
parent dies: `survival` and `restart-recovery`. Their producers live in
`bench/fixtures/`.

## Things the benchmark has to do that a real session does not

These are bench-environment repairs, not favours to any implementation:

- **Theme.** Pi's interactive theme is initialised explicitly, because
  extensions that render tool output through it throw `Theme not initialized`
  in a headless SDK session and a real Pi session always has it.
- **Shell.** `SHELL` and `PI_ASYNC_SHELL` are pinned to `/bin/sh`. Without
  this, `pi-exec-command` runs commands through the ambient `$SHELL`, which on
  this machine is Nushell, and would be measured on a different language.
- **Guard.** `bench/guard.ts` catches process-level exceptions. At least two
  implementations deliver a completion callback after the session was disposed
  and Pi's loader throws on the stale context; without the guard one of them
  ends the whole run.
- **Timeouts.** Every tool call carries one. `jobs attach` never returns in some
  states, and a benchmark that hangs is a benchmark that reports nothing.

## Limits

- All eight competitors are pinned in `bench/vendors/package.json`, including
  `pi-background-tasks`, and each one is loaded through the entry it declares
  for itself. Nothing is read from the machine's global Pi store, so the field
  no longer depends on what that machine happens to have installed.
- `pi-exec-command@0.3.10` publishes three of its own bundled packages as
  `file:../<name>` dependencies, which pnpm 11.29 and later refuse with
  `ERR_PNPM_LOCAL_SUBDEP_NOT_ALLOWED`. `bench/vendors/pnpm-workspace.yaml`
  rewrites them through `overrides` to the exact versions the tarball bundles,
  so the installed code is the same and the install is reproducible.
- `pi-shell-jobs` needs `@homebridge/node-pty-prebuilt-multiarch` for `tty: true`.
  It is in the vendor manifest for that reason. Its install script is denied in
  `bench/vendors/pnpm-workspace.yaml`, so the native binding is absent and the
  `shell-jobs` rows in `REPORT.md` were measured without it. Allowing the build
  changes what those rows measure, so flip it and regenerate the report in the
  same change.
- `pi-process-monitor` and `@alignfirst/pi-background` were probed and dropped:
  the first registers no agent-facing tool, the second only a parameterless
  `background()`. Neither can express the scenarios.
