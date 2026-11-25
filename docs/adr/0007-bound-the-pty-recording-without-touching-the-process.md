# 0007. Bound a `pty` recording with a writer, not with `script(1)`

- **Status:** Accepted
- **Applies to:** 0.2.3
- **Supersedes:** none
- **Design:** `docs/design/03-execution-model-and-primitives.md` §2, `docs/design/05-durability-and-containment.md`

## Context

A `pipe` execution's log has a cap, and the cap is a logging policy: the pipe
supervisor reads everything the child writes, appends at most `capBytes`, drops
the rest and records `log-cap.json`. The command is never stopped, never
signalled and never blocked, which is C5 — drain, never stop reading.

A `pty` execution had no cap at all. `script(1)` wrote the recording straight
into `combined.log`, so the file grew for as long as the terminal ran, and
`docs/implementation-notes.md` §4 said so and advised `timeoutSeconds` plus
storage monitoring. A long-lived, verbose PTY program could fill a disk, and the same
run would take the record write down with it.

The obvious fix is util-linux's own limit. It was measured on this machine
(util-linux 2.42.4) before it was rejected:

```console
$ script -q -f -e -c 'sh -c "seq 1 200000; echo MARK-AFTER"' /dev/null --output-limit 4KiB > /tmp/a.log 2>&1
rc=1   bytes=6349   MARK-AFTER is absent
$ script -q -f -e -O /tmp/c1.log -c 'sh -c "seq 1 200000; echo MARK-AFTER"' --output-limit 4KiB > /tmp/c2.log 2>&1
rc=1   typescript=4314   stdout=4120
```

The limit ends the session: the command is killed mid-run, the marker never
prints, and the exit code becomes 1. It also applies to the typescript file and
to stdout alike, so it cannot be aimed at the log without aiming it at the
process. Adopting it would make the largest log a reason for a failed execution,
which is exactly what C5 forbids on the pipe path.

## Options

| Option | What it costs | Why it was not taken |
|---|---|---|
| `script --output-limit` | Nothing to implement | It terminates the command. A logging cap would become a process policy, and the exit code would report a full disk as a command failure |
| Rotate or truncate the file from the front | A bounded file of constant size | `log-manager.ts` caches byte offsets in a sparse line index. Front truncation invalidates every cached offset, and a rotation needs a reader protocol the read path does not have |
| Stop the writer with `SIGSTOP` at the cap | The file stops growing | The terminal blocks: `script` writes into a pipe the paused reader no longer drains, so the recorded process hangs. That is a process policy wearing a logging policy's clothes |
| Read the file and truncate when it grows | No extra process | The writer keeps appending at its own offset, so truncation leaves a sparse hole and the next append lands at the old offset. Reads then see a file whose tail is a hole |
| Put a bounded writer between `script(1)` and the file | One extra process on the recording path | Taken |

## Decision

`script(1)` writes into a pipe, and `src/core/recording-writer.mjs` writes that
pipe into `combined.log`. The writer reads without ever stopping, appends at
most `capBytes`, drops the rest, and writes `log-cap.json` once. The cap is
`maxLogBytes`, the same value and the same record the pipe supervisor uses, so
`bytes.capReached` means the same thing on both bindings.

The retained bytes are the **beginning** of the recording. A prefix keeps every
offset the line index has cached, which a rotating file cannot, and it matches
the pipe path, which also keeps the head and drops the tail. The writer's own
status never decides the execution's status: `script`'s status is carried out of
the pipeline through `$d/script.rc`, because POSIX reports the last stage of a
pipeline.

Writes are synchronous in the writer. A queued write would be lost when the
wrapper's group is signalled, and the recording is the only witness a cancel
leaves behind.

## Consequences

- A `pty` recording stops growing at `maxLogBytes` and the command keeps
  running to its own end. A full log costs output, never the process.
- The head-only rule is visible to a reader: after `capReached`, a `tail` read
  describes the end of the retained prefix, not the end of the program's output.
  `docs/implementation-notes.md` §4 states it, and the handle says "log cap reached".
- An unwritable recording is a diagnostic. The writer keeps draining, so a full
  disk does not turn into a hung terminal.
- The recording path now depends on the same Node binary that loads the
  extension, passed to the wrapper as `PI_ASYNC_SHELL_NODE`, instead of
  whatever `node` happens to be first on `PATH`.
- `shell_read` and `shell_await` need no change: they still read one file, and
  the `ptyView` replay still reads the same bytes through the same symlink.

## Evidence

`tests/pty.test.ts` — "a pty recording stops at the log cap without killing the command"; `tests/pty-durability.test.ts` — "an unpromoted session pty stops when its owner is killed"; `tests/registry.test.ts` — "the session pipe log cap drains instead of killing or blocking the child".
