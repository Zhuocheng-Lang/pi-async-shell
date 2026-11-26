---
name: async-shell-maintainer
description: Develop, debug, test, document, and release the pi-async-shell extension itself. Use for changes to its source, tools, lifecycle, registry, logs, prompt contracts, skills, or package. Keep ordinary project builds and tests with the async-shell skill.
---

# Maintain pi-async-shell

Resolve relative paths from the pi-async-shell repository root.

## Route work by ownership

- When changing or debugging the pi-async-shell package, use this skill.
- When using pi-async-shell to build, test, or operate another project, use the async-shell skill.
- When a task covers both targets, split the work by repository and file ownership.
- Treat command names as neutral. A consumer project's pnpm test belongs to async-shell. The package's own pnpm test belongs here.

## Read canonical contracts

Read the row that matches the change before editing. Follow the cited sections instead of copying architecture into skill files.

| Question | Canonical source |
|---|---|
| Setup, change requirements, and release workflow | CONTRIBUTING.md |
| Current mechanics and test evidence | docs/implementation-notes.md |
| Tools, waits, completion, and logs | docs/design/03-execution-model-and-primitives.md |
| Spawn recipes and runtime architecture | docs/design/04-runtime-architecture.md |
| Durability, identity, and containment | docs/design/05-durability-and-containment.md |
| Skill routing and content ownership | docs/design/06-skill-boundaries.md |
| Tool registration and prompt contracts | src/extension.ts |
| Registry, process, and log implementations | src/core/ |

## Change and check

1. Inspect the working copy before editing. Use jj status in a jj repository.
2. Read the owning source, tests, and canonical documentation.
3. Add a regression test that fails before a behavior fix.
4. Update both READMEs after user-visible behavior changes. Add a changelog entry under [Unreleased].
5. Run focused checks during iteration. Before every pull request, run the full check.

```sh
pnpm verify
```

For focused iteration, use these commands:

```sh
pnpm typecheck
pnpm test
pnpm run check:docs
```

Run pnpm run spec after changing ownership or delivery invariants. Run pnpm pack --dry-run before publishing. When vale and lychee are on PATH, run pnpm run docs after documentation changes.

## Internal runtime map

Keep these implementation details in this skill and the canonical documentation. Keep them out of the daily async-shell skill.

### Single-shot lifecycle and delivery

In print or JSON mode, agent_before_settle holds live, unready session executions. notifyOnCompletion and triggerOnCompletion must both be true. Readiness releases the hold. Final session_shutdown reaps remaining session executions.

The internal wait observes exit or readiness without consuming completion. The completion channel owns delivery. An await result that reports a settle sets consumedByAwait and suppresses duplicate delivery.

### Log and workspace mechanics

pipe-supervisor.mjs drains pipe output and writes bounded files. recording-writer.mjs bounds PTY recordings between script(1) and the file. Both mechanisms retain the output prefix after the cap. Registry GC deletes expired terminal history.

One writer lock controls workspace mutation. Read-only observers retain status and log reads. workspaceOwner reports the current process's ownership.

### Prompt and skill maintenance

toCodemodeDeclaration appends guidelines to each tool declaration without cross-tool deduplication. buildRules deduplicates identical strings in the normal rules path.

Keep call facts in descriptions and parameter schemas. Keep pre-call rules on their owning tools. Keep consumer workflows in async-shell. Keep contributor workflows and internal mechanisms here.

Use docs/design/06-skill-boundaries.md as the ownership contract. Update that contract before adding another skill or changing these triggers.
