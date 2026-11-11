---
name: async-shell
description: Run and supervise durable asynchronous shell work in pi-async-shell. Use for dev servers, slow builds or tests, parallel commands, readiness waits, workspace promotion, and interactive PTY programs.
---

# Async shell workflows

Use shell_start for work that should return a handle immediately. Keep Pi's bash tool for commands that finish in a few seconds and need no log workflow.

Commands use /bin/bash -c by default, falling back to /bin/sh. Ambient $SHELL is ignored. PI_ASYNC_SHELL is an explicit override.

## Start a server and run dependent tests

1. Start the server with shell_start. Use the default session scope and pipe binding.
2. Wait for its actual readiness signal with shell_await. Do not sleep or poll shell_status.
3. Start tests with shell_start, then wait for exit.
4. Read only the useful log slice with shell_read.

Tool-call sequence:

```json
shell_start({
  command: "pnpm run dev -- --port 3000",
  name: "dev server"
})

shell_await({
  ids: "sh_server_id",
  until: { kind: "pattern", regex: "Local:.*3000" },
  waitMs: 15000
})

shell_start({ command: "pnpm test", name: "test suite" })
shell_await({ ids: "sh_test_id", waitMs: 50000 })
shell_read({
  id: "sh_test_id",
  mode: "grep",
  pattern: "FAIL|Error|error",
  context: 3
})
```

Adjust the regular expression to the server. A wait timeout never kills the server or tests.

## Prefer an explicit ready marker

A command can create $PI_ASYNC_SHELL_EXEC_DIR/ready after its own health check succeeds. This is more reliable than scraping output.

```sh
pnpm run dev &
server_pid=$!
until curl -fsS http://localhost:3000/health >/dev/null; do sleep 0.2; done
touch "$PI_ASYNC_SHELL_EXEC_DIR/ready"
wait "$server_pid"
```

Then call:

```json
shell_await({ ids: "sh_server_id", until: { kind: "ready" }, waitMs: 15000 })
```

Do not pass readiness to shell_start. Output patterns and the ready marker belong to shell_await.

## Drive an interactive program

Start with binding pty. Wait for a prompt pattern, send text or key chords, then read the rendered screen.

```json
shell_start({
  command: "python -q",
  binding: "pty",
  name: "python repl"
})
shell_await({
  ids: "sh_repl_id",
  until: { kind: "pattern", regex: ">>>", stream: "combined" }
})
shell_send({ id: "sh_repl_id", text: "print(2 + 2)", keys: ["Enter"] })
shell_read({ id: "sh_repl_id", stream: "ptyView" })
```

shell_send refuses pipe bindings. Output patterns can match a prompt even when it has no trailing newline.

## Choose ownership

- session is the default. Work survives the turn and /reload, but ends with its owning Pi session.
- workspace survives Pi process restarts and can be adopted by a later session.
- shell_promote({ id, to: "workspace" }) releases either a pipe or pty session without restarting it.

Do not use scope turn; it no longer exists.

## Wait within the caller budget

shell_await waitMs defaults to 30000 and has a maximum of 50000. In codemode, use a smaller value when the script has other work because the default script budget is 60 seconds. For longer waits, end the turn and rely on completion delivery instead of repeated polling.

Cancellation stops processes but does not roll back their effects. Use shell_cancel only when termination is intended.

## Completion delivery

A command that settles while nothing awaits it notifies you. If you are still working, the notification arrives before your next LLM call, so you do not have to end the turn to learn that a command finished. shell_start delivery: "settle" holds the notification until the run settles instead.

## Environment and logs

Ambient API keys, common access tokens, and credential variables are filtered by default. shell_start.env can explicitly restore a variable, but tool arguments can enter the session transcript. Do not place real credentials there without user authorization.

Pipe logs stop growing at their cap while output continues to drain. PTY recordings write directly to disk and do not use that cap. Use timeoutSeconds for runaway duration and let registry GC remove expired terminal history.
