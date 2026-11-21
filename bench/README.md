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

- `pi-background-tasks` is the globally installed copy under
  `~/.pi/agent/npm/node_modules`, not a vendored one. Its version is recorded in
  the report. Set `PI_GLOBAL_NODE_MODULES` when Pi's global store lives
  elsewhere.
- `pi-shell-jobs` needs `@homebridge/node-pty-prebuilt-multiarch` for `tty: true`.
  It is in the vendor manifest for that reason. Its install script is denied in
  `bench/vendors/pnpm-workspace.yaml`, so the native binding is absent and the
  `shell-jobs` rows in `REPORT.md` were measured without it. Allowing the build
  changes what those rows measure, so flip it and regenerate the report in the
  same change.
- `pi-process-monitor` and `@alignfirst/pi-background` were probed and dropped:
  the first registers no agent-facing tool, the second only a parameterless
  `background()`. Neither can express the scenarios.
