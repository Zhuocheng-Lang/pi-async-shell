# 0004. Remove the `pane` binding and `shell_attach`

- **Status:** Accepted
- **Applies to:** 0.2.0
- **Supersedes:** none
- **Design:** `docs/design/01-overview.md` section 5; `docs/design/00-terminology.md` section 10

## Context

An earlier draft carried a third binding, `pane`, backed by Zellij, and an eighth
tool, `shell_attach`, which surfaced a pane to a human.

Both existed to serve one capability: a third party attaching to the terminal an
execution is using. That capability needs a long-lived broker that owns the PTY
master for longer than any single client. It is also the only capability the
multiplexer bought, and it came at a cost the design had not priced: the
extension would own a terminal a human might be typing into, which imports a
presentation concern into a supervision model.

## Options

| Option | What it costs | Why it was not taken |
|---|---|---|
| Keep `pane` and `shell_attach` | An eighth tool, a multiplexer dependency | The supervision model gains nothing; only presentation does |
| Keep `pane`, drop attach | A binding that cannot be reached | Dead surface |
| Remove both | No third-party attach | Taken |

## Decision

The binding axis has two values, `pipe` and `pty`. There is no attach surface.
Terminal interaction is agent-only: `shell_send` for input and
`shell_read(stream: "ptyView")` for the rendered screen. A human who wants the
terminal runs the command under their own multiplexer.

## Consequences

- No multiplexer dependency, and no extension responsibility for a terminal a
  person may be sitting in.
- `ptyView` is a replay of a recording, not a live mirror. That is why reading the
  screen can never change what the program sees, which is what makes contract C7
  true rather than aspirational.
- The interactive half of the matrix is deliberately smaller than it could be.
  Widening it again needs a new ADR that prices the attach surface.

## Evidence

`tests/pty.test.ts` asserts the seven-tool surface and that `ptyView` is the
rendered screen rather than the raw stream.
