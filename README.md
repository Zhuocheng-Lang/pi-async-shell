# pi-async-shell

Run slow commands without blocking Pi, keep their logs, and recover workspace jobs after a Pi restart.

pi-async-shell adds seven supervised shell tools. It supports parallel builds, dev servers, searchable output, interactive PTY programs, and promotion from a session to a durable workspace job.

[中文说明](README.zh-CN.md)

```
Status: beta · Linux only for now
```

## Try it in three minutes

Requirements: Linux, Node.js 22.19 or later, and Pi. PTY commands also use script(1), mkfifo(1), and stty(1).

Try the package for one Pi invocation without changing your settings:

```sh
pi -e npm:pi-async-shell
```

Install it for daily use:

```sh
pi install npm:pi-async-shell
```

The package includes an async-shell skill with server, readiness-marker, test, promotion, and PTY recipes.

## Hard rules from dogfooding

- Use shell_start for long, parallel, or log-worthy work. Keep the bash tool for commands that finish in about a second.
- Do not pipe output to tail, head, grep, or wc. A pipe truncates the durable log before shell_read can search it, and on a shell without pipefail it also replaces the source exit code. Use shell_read modes tail, grep, offset, or all instead.
- Pass cwd to shell_start instead of prefixing the command with cd.
- Use one long blocking await per codemode script, leave room in the 60-second budget, and end the turn after a full-length wait. Completion delivery wakes the next decision.
- Pipelines on bash-like shells run with set -o pipefail; any stage failure fails the command. The /bin/sh fallback reports only the last stage and labels the handle with exitSource: last-command.
- waitMs above 50000 and inlineSettleMs above 10000 are clamped with a note, not rejected.

## Use a ready marker when output is ambiguous

Every command receives PI_ASYNC_SHELL_EXEC_DIR. Create ready inside that directory after a real health check:

```sh
pnpm run dev &
server_pid=$!
until curl -fsS http://localhost:3000/health >/dev/null; do sleep 0.2; done
touch "$PI_ASYNC_SHELL_EXEC_DIR/ready"
wait "$server_pid"
```

Wait for the marker through shell_await:

```ts
shell_await({
  ids: "sh_1234abcd",
  until: { kind: "ready" },
  waitMs: 15000
});
```

There is no shell_start.readiness option. Output regular expressions and the ready file are both wait conditions, not spawn options. Patterns can match a prompt before it prints a newline.

## Choose ownership and I/O independently

| Setting | Behavior |
|---|---|
| scope: session (default) | Survives the turn and /reload; ends with the owning Pi session. |
| scope: workspace | Survives a Pi restart and can be adopted by a later process. |
| binding: pipe (default) | Separate stdout and stderr files plus combined output. No stdin. |
| binding: pty | A real terminal, key input through shell_send, and rendered-screen reads. |

Use shell_promote({ id, to: "workspace" }) when a session command must outlive Pi. Both pipe and pty sessions promote without a respawn or log transition.

scope turn is intentionally absent. Ending a turn never cancels a session command.

## The seven tools

| Tool | Purpose |
|---|---|
| shell_start | Start with session/workspace ownership and pipe/pty I/O. |
| shell_await | Wait for exit, the ready marker, or an output regular expression. |
| shell_read | Read tail, head, offsets, grep results, or a bounded all view from log slices. |
| shell_promote | Move live session work to workspace ownership. |
| shell_send | Send text or key chords to a pty through its durable stdin FIFO. |
| shell_cancel | Run the signal ladder and verify process-tree cleanup. |
| shell_status | Inspect current handles; do not use it as a polling loop. |

shell_await waitMs defaults to 30000 and is clamped to 50000; an over-limit value is reported in the result note. This leaves room in codemode's 60-second default script budget. After a full-length wait, end the turn and let completion delivery wake you. A timeout or aborted wait never cancels the command. shell_read mode all is a bounded head read (2000 lines / 50 KiB) whose note explains paging with offset.

## How a completion reaches the agent

A command that settles while nothing is awaiting it produces one completion message. When the agent is still running, that message is steered in before the next LLM call, so a build that finished mid-turn informs the next decision instead of arriving after the run is over.

| shell_start setting | Effect |
|---|---|
| delivery: steer (default) | The record reaches a running agent before its next LLM call. |
| delivery: settle | The record waits for the settle boundary, so the current plan finishes first. |
| notifyOnCompletion: false | No completion message; the record stays on disk. |
| triggerOnCompletion: false | An idle session stores the record without starting a turn. |

Completion messages and await results carry the exit code and a bounded output excerpt: the tail on success, or the first error block plus tail on failure. Records that settle within the same 150 ms window travel as one message. A shell_await that consumed a handle suppresses its completion, and a workspace record never starts a turn by itself.

## Environment, storage, and limits

- Commands run with /bin/bash -c by default, falling back to /bin/sh. Ambient $SHELL is ignored because a login shell is not necessarily a POSIX script interpreter. Set PI_ASYNC_SHELL to override the command shell explicitly.
- Ambient variables matching common credential forms, including *_API_KEY, *_API_SECRET, *_SECRET_KEY, *_ACCESS_TOKEN, *_AUTH_TOKEN, *_SESSION_TOKEN, and several common cloud/token names, are filtered before spawn. shell_start.env explicitly overrides the filter. Tool arguments can enter the session transcript, so do not put real credentials there without authorization.
- Runtime state lives under .pi/async-shell/. The extension creates a local .gitignore containing *. Existing .gitignore content is not replaced.
- Pipe logs default to a 100 MiB cap (PI_ASYNC_SHELL_MAX_LOG_BYTES). At the cap, recording stops but stdout/stderr continue to drain, so output volume cannot block or kill the command.
- PTY recordings write directly from script(1) to disk and do not use the pipe cap. Use timeoutSeconds and storage monitoring for long-lived, verbose PTY programs.
- Completions that settle close together travel in one message. The window is 150 ms by default; PI_ASYNC_SHELL_COALESCE_MS widens or narrows it, and 0 sends each settle on its own.
- GC runs at registry startup and hourly. It removes terminal records after 24 hours by default, or old records beyond the 100-record limit after a five-minute grace period. Running, nonterminal, protected, and current-session records are never collected. Tune with PI_ASYNC_SHELL_GC_RETENTION_MS and PI_ASYNC_SHELL_GC_MAX_RECORDS.
- Cancellation is not rollback, and the environment filter is not a security sandbox. Commands retain the user's filesystem and network permissions.

## Development and evidence

```sh
pnpm install          # TypeScript, Node types and the pinned Pi host packages
pnpm verify           # typecheck plus the full test suite
pnpm pack --dry-run   # the files the published tarball would contain
```

Nothing has to be installed globally: the type checker and the Pi host packages are devDependencies, pinned to the versions the suite is verified against. The benchmark needs two more steps first; see [bench/README.md](bench/README.md).

The test suite uses real processes and a real Pi SDK session with a faux provider. It covers default shell selection, credential filtering, readiness, partial-line prompts, log caps, GC safety, cancellation, hard-kill durability, promotion, workspace adoption, reload handoff, and tool schemas.

[bench/REPORT.md](bench/REPORT.md) contains the generated comparison against Pi's bash tool and nine background/task extensions. [docs/implementation-notes.md](docs/implementation-notes.md) explains the runtime. The design series in [docs/design/](docs/design/) records terminology, trade-offs, and ecosystem context.

## License

[MPL-2.0](LICENSE)
