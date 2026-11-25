# 0005. Run `script(1)` in the foreground of the PTY wrapper

- **Status:** Accepted
- **Applies to:** 0.2.3
- **Supersedes:** none
- **Design:** `docs/design/03-execution-model-and-primitives.md`, `docs/design/05-durability-and-containment.md`

## Context

The `pty` binding is a shell recipe, not a native binding. The wrapper creates a
read-write FIFO for stdin, hands fd 3 to an owner watcher, and starts `script(1)`
to allocate the terminal and write the recording. Until this decision, it started
`script` with `&` and waited for it, because the wrapper has to survive the
recording to seal `exit.json`.

That placement is what broke `^C` on half the Linux installs in the field. POSIX
sets SIGINT and SIGQUIT to `SIG_IGN` in the child of an asynchronous list. A
non-interactive shell that inherited an ignored signal cannot reset it: in
`dash`, `trap - INT QUIT` is a no-op, and `dash` is `/bin/sh` on Debian and
Ubuntu. The result is silent. The byte reaches the line discipline, the terminal
echoes `^C`, the recording shows it, and the foreground process group stays
alive, so a graceful cancel has nothing to do but wait out `graceMs` and
escalate to SIGKILL. `bash` does not honour the rule, so a CachyOS or Arch
machine never showed the defect, and no test sent a `^C`.

## Options

| Option | What it costs | Why it was not taken |
|---|---|---|
| Keep `script` asynchronous, reset the disposition inside the subshell | Nothing, if it worked | It does not work. The shell marks the signal as ignored on entry, and `trap` cannot lift that; this is the defect, restated |
| Run the wrapper itself under `bash` | One hard dependency on a shell this package does not otherwise require | Correct where bash exists and absent on Alpine and in minimal images. The wrapper is the one script that must run everywhere |
| Start `script` in a foreground subshell | Nothing | A foreground subshell is still a child of the shell that traps; the wrapper loses the exit code and gains no disposition |
| Run `script` in the wrapper's foreground, move the watch to the background | The watcher no longer knows `script`'s pid, so it signals the process group | Taken |

## Decision

`script(1)` runs in the foreground of the wrapper. Only the owner watcher is
asynchronous, and it runs `kill` and nothing else, so the disposition it inherits
cannot reach a command. The wrapper traps SIGTERM so that a group signal cannot
take it down before it seals `exit.json`; a shell trap does not propagate, so
children keep the default. Because the watcher no longer has `script`'s pid, it
signals the whole group and escalates to SIGKILL one second later. The wrapper is
detached, so the group is its own and cannot reach Pi.

The watcher is stopped with SIGKILL rather than SIGTERM. SIGTERM is the signal
that means "the owner is gone", and a watcher that traps it cannot tell a normal
shutdown from the event it exists to detect.

## Consequences

- `^C` reaches the foreground process group on every host whose `/bin/sh` is
  POSIX about asynchronous lists, which is the majority of Linux installations.
- The wrapper must be able to survive SIGTERM while a foreground child runs, and
  POSIX provides exactly that: a trap runs after the foreground command returns.
- A group signal reaches the wrapper too. The trap is what makes the exit record
  still get written, and it costs the wrapper nothing else, because it is not a
  member of the terminal's foreground process group.
- The escalation is a group SIGKILL, so a wrapper that survives an unresponsive
  `script` dies with it and the registry seals the record in `finalize` instead.
- The launcher path moved into `PI_ASYNC_SHELL_EXEC_DIR` for the `-c` string, so a
  workspace whose path contains a space starts a `pty` at all.

## Evidence

`tests/pty.test.ts` — "a pty does not hand its command an ignored SIGINT", "a pty cancel interrupts the terminal instead of waiting out the grace period"; `tests/pty-durability.test.ts` — "a workspace pty survives a hard Pi exit and is re-adopted".
