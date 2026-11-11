# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x (beta) | Yes |
| < 0.2 | No |

The package is in beta. Fixes land in the latest published release; older releases do not receive backports.

## Report a vulnerability

Report privately through GitHub: open the **Security** tab of the repository and choose **Report a vulnerability**. If you cannot use GitHub, write to 2435060515@usst.edu.cn.

Do not open a public issue for a suspected vulnerability.

Please include:

- the pi-async-shell version, the Pi version, and the distribution and kernel;
- the tool calls or settings that trigger the problem, with secrets removed;
- what an attacker gains: which files, processes or credentials become reachable;
- whether the problem survives a restart, and whether it needs `scope: "workspace"` or `binding: "pty"`.

Expect an acknowledgement within 7 days and an assessment within 30 days. This is a single-maintainer project, so those are best-effort targets, not a service commitment. A fix ships as a new version with an entry under Security in `CHANGELOG.md`, and reporters are credited unless they ask otherwise.

## What this project does and does not protect

pi-async-shell runs commands with the permissions of the user who started Pi. It is an execution supervisor, not a sandbox. The following are documented limits, not vulnerabilities:

- **The environment filter is not a boundary.** Common credential variable names (`*_API_KEY`, `*_SECRET_KEY`, `*_ACCESS_TOKEN` and similar) are dropped before spawn, but a command can still read files, reach the network, or inspect processes it can see. `shell_start.env` bypasses the filter by design.
- **Cancellation is not rollback.** A cancelled command keeps whatever it already wrote to disk or to a remote system.
- **Runtime state is plaintext on disk.** `.pi/async-shell/` holds full command output, including anything a command printed. The extension writes a local `.gitignore` containing `*`, which prevents an accidental commit, not a reader.
- **Workspace executions outlive Pi.** A `scope: "workspace"` execution keeps running after Pi exits, by design, and a later Pi process can adopt it.
- **The protected-paths integration is a local extension hook.** It blocks obvious writes to `.env*`, `.git/`, `.jj/`, `node_modules/` and `~/.ssh/` from `shell_start` commands and `shell_send` input. It guards against mistakes; it is not an enforced boundary.

## In scope

Reports are most useful when they describe one of these:

- a command that receives a credential variable the filter claims to remove, without an explicit `shell_start.env` entry;
- a handle that is adopted, cancelled or garbage-collected across a PID reuse and acts on the wrong process;
- a log, FIFO or record path that can be made to read or write outside `.pi/async-shell/`;
- a PTY FIFO or recording that another local user can read or write;
- a tool argument that reaches a shell, a path or a log without the documented quoting or validation.
