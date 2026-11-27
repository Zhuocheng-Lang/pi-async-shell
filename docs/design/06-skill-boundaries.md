---
kind: normative
applies_to: 0.2.4
tracks:
  - skills/async-shell/SKILL.md
  - skills/async-shell-maintainer/SKILL.md
  - tests/skill-boundaries.test.ts
---

# 06. Skill Boundaries

## 1. Purpose

The package publishes two skills. The async-shell skill serves people who use the extension. The async-shell-maintainer skill serves people who change the extension.

This separation protects the daily prompt budget. It also gives contributor guidance one discoverable owner.

The boundary covers skill prose. Public tool schemas and result fields remain governed by the execution contracts.

## 2. Routing by Task Ownership

| Task target | Skill | Examples |
|---|---|---|
| Use the extension in a consumer repository | async-shell | shell_start, shell_await, shell_read, shell_send |
| Change, debug, document, or release the extension itself | async-shell-maintainer | src/, tests/, docs/, package.json |
| Cover both targets in one request | Split by target | async-shell for consumer work, async-shell-maintainer for package work |

Repository ownership and task intent select the skill. Command names do not. A consumer project's pnpm test uses async-shell. The package's own pnpm test uses async-shell-maintainer.

User recovery belongs to async-shell even when the agent reads logs. Changing recovery behavior belongs to async-shell-maintainer.

## 3. Content Ownership

| Content | Owner | Canonical contract |
|---|---|---|
| Tool selection, calls, readiness, PTY, scope, completion options, and bounded reads | async-shell | docs/design/03-execution-model-and-primitives.md |
| User recovery for lost executions, read-only workspaces, and capped logs | async-shell | docs/design/05-durability-and-containment.md |
| Contributor setup, change workflow, verification, and release | async-shell-maintainer | CONTRIBUTING.md |
| Lifecycle hooks and delivery internals | async-shell-maintainer | docs/implementation-notes.md |
| Process, log, writer-lock, and GC internals | async-shell-maintainer | docs/design/04-runtime-architecture.md |
| Prompt contracts and skill maintenance | async-shell-maintainer | docs/design/06-skill-boundaries.md |

Keep contributor rows out of skills/async-shell/SKILL.md. Put short maintainer summaries in skills/async-shell-maintainer/SKILL.md. Keep full mechanics in the canonical contracts.

## 4. Public Behavior and Internal Mechanisms

The daily skill may describe observable behavior without internal names. It can explain print/JSON settlement, completion delivery, and capped-log prefix semantics.

Keep internal hook and mechanism names in maintainer material. Examples include agent_before_settle, session_shutdown, consumedByAwait, pipe-supervisor.mjs, recording-writer.mjs, and script(1).

Keep user recovery fields in daily material. lost, workspaceOwner, and bytes.capReached drive user decisions. Their presence does not make the skill maintainer-oriented.

Tool schemas and result fields remain public contracts. This boundary restricts skill prose alone.

## 5. Change Procedure

1. Classify the target as consumer work or package work.
2. When a user needs a new action or decision, update async-shell.
3. When contributor workflow changes, update async-shell-maintainer and CONTRIBUTING.md.
4. When mechanics change, update docs/design/ and docs/implementation-notes.md. Keep only a short summary in async-shell-maintainer.
5. Keep the two frontmatter descriptions disjoint.
6. Update both language mirrors with the same structure and code identifiers.
7. Run pnpm verify after changing either skill or this contract.

## 6. Evidence

Evidence: `skill-boundaries.test.ts` — "daily and maintainer skills have disjoint routing and ownership".
