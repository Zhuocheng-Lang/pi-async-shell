---
name: async-shell
description: Run and supervise durable asynchronous shell work in pi-async-shell. Use for dev servers, slow builds, tests, parallel commands, readiness waits, workspace promotion, and interactive PTY programs.
---

# Async shell workflows

Use shell_start for durable handles and logs. Keep Pi's bash tool for commands that finish within two seconds and need no log.

When the command outlives inlineSettleMs, shell_start returns a handle. When the command settles within inlineSettleMs, the start result includes its status and output tail. The start result is the only delivery for an inline settle.

Commands use /bin/bash -c by default. The fallback is /bin/sh. The runtime ignores ambient $SHELL. Set PI_ASYNC_SHELL to override the interpreter.

## Hard rules

- Use shell_start for slow commands, parallel commands, durable logs, or work that outlives the turn. Keep Pi's bash tool for commands that finish within two seconds and need no log.
- Preserve complete command output in the durable log. Use shell_read instead of tail, head, grep, or wc output pipes. Output pipes can truncate the log or replace the source exit code.
- Pass cwd to shell_start instead of prefixing the command with cd.
- Finish independent work before waiting. Use at most one long blocking wait in each codemode script. Reserve time within the 60-second script budget. When a full-length wait expires, end the turn. Let completion delivery resume the work.
- Before starting a wait, identify the later action that uses its outcome. When no later action needs an external state change, report the verified result and stop. Skip polling and watchers in this case.
- When a later action needs an external state change, start one command that exits on that change. Set timeoutSeconds. Await that command once. If the wait expires, end the turn and let completion delivery resume the work.
- Wait for readiness with until: pattern or a ready marker. Use shell_await instead of status polling or sleep loops.
- Bash-like shells apply set -o pipefail to pipelines. Any failing stage then fails the command. The /bin/sh fallback takes the exit code from the last stage. The handle and completion message name exitSource.
- Completion messages and await results include the exit code and a bounded output excerpt. When the excerpt lacks needed evidence, read more with shell_read.
- The tool clamps waitMs above 50000 and inlineSettleMs above 10000. The result note reports the clamp. Use the documented maxima for planning.

## Start a server and run dependent tests

1. Start the server with shell_start. Use the default session scope and pipe binding.
2. Wait for the server's readiness signal with shell_await. Use output patterns or a ready marker instead of polling.
3. Start tests with shell_start. Wait for exit with shell_await.
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

Adjust the regular expression to the server's readiness output. A wait timeout leaves the server and tests running.

## Prefer an explicit ready marker

When the program has a health check, create $PI_ASYNC_SHELL_EXEC_DIR/ready after that check succeeds. Prefer this marker to output scraping.

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

Pass readiness conditions only to shell_await. shell_start has no readiness parameter.

## Drive an interactive program

1. Start the program with binding: "pty".
2. Wait for a prompt pattern.
3. Send text or key chords.
4. Read the rendered screen with ptyView.

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

shell_send accepts only pty bindings. Output patterns can match prompts without trailing newlines.

## Choose ownership

- session is the default. Work survives turns in a resident session and across /reload. In print or JSON mode, pending waking work holds settlement until completion or readiness. Final session shutdown reaps every remaining session execution.
- workspace survives Pi process restarts and single-shot exits. A later session can adopt its executions.
- shell_promote({ id, to: "workspace" }) releases a pipe or pty session without restarting it.

Pending waking work is live and unready. Both notifyOnCompletion and triggerOnCompletion are true. Ready companions and executions with either option false release a single-shot run.

When readiness is the required milestone, give a companion service a ready marker.

Use only session or workspace for scope. The removed turn scope is invalid.

## Wait within the caller budget

shell_await waitMs defaults to 30000. The tool clamps values above 50000. The result note reports the clamp.

When a full-length wait expires, end the turn. Completion delivery starts the next decision. Repeated blocking waits consume the codemode script budget.

shell_read returns at most 2000 lines or 50 KiB per call. The first reached limit applies.

mode: "all" performs a bounded head read within that budget. When the result reaches a limit, continue with mode: "offset". Use lineOffset: range.nextLine or byteOffset: range.nextByte.

A ptyView read is a viewport, not a page. It returns the current screen, names no next page, and reports truncated when the replay covered only part of the recording. Read stream "combined" when you need the bytes.

Structured callers read the result object rather than display text. In codemode, check settled, timedOutWaiting, outcomes, stillRunning, and note together.

An expired wait returns an empty outcomes list. Its note carries the next action. Checking only outcomes cannot distinguish expiry from failure.

Use shell_cancel only to stop work. Cancellation leaves filesystem and external side effects in place.

## Wait for an external state, or do not wait

Every wake-up comes from an execution that exits. A bare external condition has no completion event.

Wait only on a process whose exit signals the required state change.

- When no later action needs the new state, report the verified result and stop. Polling cannot accelerate another system's schedule.
- When a later action needs the new state, start one watcher that exits on the change. Set timeoutSeconds. Await the watcher once. If it expires, end the turn and let its completion resume the work.

```json
shell_start({
  command: "until curl -fsS https://example.test/version | grep -q 1.2.3; do sleep 5; done",
  name: "wait for publish",
  timeoutSeconds: 900
})
shell_await({ ids: "sh_wait_id", waitMs: 30000 })
```

## Completion delivery

When no wait consumes a settle, the completion channel reports it. An await result reports its settles. The completion channel skips those records.

The matrix covers only unconsumed settles. While the agent runs, delivery selects the arrival path. When the agent is idle, both values use the follow-up path.

| notifyOnCompletion | triggerOnCompletion | While running (steer / settle) | When idle | Live, unready session work in print/JSON |
|---|---|---|---|---|
| false | either | The runtime queues no completion. | The runtime sends no message and starts no turn. | The host settles without waiting for this execution. |
| true | false | steer delivers before the next LLM call. settle injects at the settle boundary. | The runtime reports the completion without starting a turn. | The host settles without waiting for this execution. |
| true | true | steer delivers before the next LLM call. settle injects at the settle boundary. | The runtime reports the completion and starts a turn. | The host waits for exit or readiness. |

Session executions default to notifyOnCompletion: true and triggerOnCompletion: true. Workspace executions default to notifyOnCompletion: false. Workspace records leave idle turns unchanged.

## Environment and logs

The runtime filters ambient API keys, access tokens, and credential variables by default. Explicit shell_start.env values restore selected variables. Tool arguments can enter the session transcript. Place real credentials in arguments only with user authorization.

PI_ASYNC_SHELL_MAX_LOG_BYTES bounds every log. The default is 100 MiB. The runtime continues reading output after the cap. The command keeps running.

A capped log retains the beginning of the output. After bytes.capReached, a tail read describes the end of that prefix. Later output remains unrecorded.

Use timeoutSeconds to bound runaway duration.

## Failure triage

- status: "lost" marks unprovable workspace liveness during adoption. It establishes neither success nor failure. Inspect the handle's error and durable logs. Treat the original outcome as unknown. Before rerunning, assess duplicate side effects.
- Workspace adoption requires the writer lock. workspaceOwner: false identifies a read-only observer. shell_status and shell_read remain available. Starting or promoting into workspace scope requires the owner. Mutating live workspace executions also requires the owner. When another live Pi process owns the lock, use that owner's session or wait for lock release. Leave lock files intact. Use event-driven coordination instead of retry loops.
