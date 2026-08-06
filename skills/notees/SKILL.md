---
name: notees
description: >
  This skill should be used when the user asks to "work on Notees",
  "add a feature to the note-taking app", "fix the Notees backend or frontend",
  "debug operation log sync", or "update the local-first note app".
  Activate for any task touching the FastAPI backend, React frontend,
  operation log, relay sync, or agent docs in this repository.
primary: true
---

# notees

Self-hosted, privacy-first, local-first note-taking application with FastAPI backend and React frontend.

<always-applicable>

## Always Read

These files apply to every task. Read them first:
<!-- ALWAYS_READ_START -->
1. `rules/project-rules.md`
2. `rules/coding-standards.md`
3. `rules/agent-behavior.md`
<!-- ALWAYS_READ_END -->

## Session Discipline

- **Re-match the route every task** (scan Common Tasks / `routing.yaml`). Never assume the new task uses the last route.
- **Re-read the route's files only when the route changed, or context was compacted**.
- Before final validation/commit after a long or interrupted task, run `protocol-blocks/reboot-check.md`.

**Route-before-routing check** — if the request contains vague improvement verbs ("refactor / clean up / optimize / make it better") without a concrete module, file, or verifiable outcome, stop and ask for scope. See `protocol-blocks/ambiguous-request-gate.md`.

</always-applicable>

<task-routing>

## Common Tasks

<!-- ROUTING_SUMMARY_START -->
- Fix bug / 修复 bug (`fix-bug`) -> reads none; workflow `workflows/fix-bug.md`; read task-relevant `rules/*.md` + `gotchas/index.md`; follow `workflows/fix-bug.md`; triggers: "fix this failing test", "this endpoint errors", "local change disappears after sync"
- Add / refactor / optimize behavior / 新增 / 重构 / 优化 (`change-managed`) -> reads none; workflow `workflows/change-managed.md`; read task-relevant `rules/*.md` + `conventions/index.md`; follow `workflows/change-managed.md`; for fan-out refactors use `workflows/refactor-fanout.md`; triggers: "add a feature", "refactor this flow", "optimize this module"
- Refactor across many usage points / 跨多处重构 (`refactor-fanout`) -> reads none; workflow `workflows/refactor-fanout.md`; follow `workflows/refactor-fanout.md`; fan-out multi-site changes to parallel subagents; triggers: "rename X across the codebase", "change this API signature everywhere"
- Plan complex feature / 规划复杂功能 (`plan-feature`) -> reads none; workflow `workflows/plan-feature.md`; follow `workflows/plan-feature.md`; triggers: "plan this feature before coding", "this is a big change"
- Profile project / 梳理项目 (`profile-project`) -> reads none; workflow `workflows/profile-project.md`; follow `workflows/profile-project.md`; write evidence-labeled conclusions; triggers: "refresh the project profile", "help me understand this codebase"
- Update skill rules / 更新 skill 规则 (`update-rules`) -> reads `gotchas/index.md`, `references/behavior-failures.md`; workflow `workflows/update-rules.md`; read `gotchas/index.md`, `references/behavior-failures.md`; follow `workflows/update-rules.md`; triggers: "record this rule", "update the project skill rules"
- Other / 其他 (`other`) -> reads none; workflow Check `workflows/` for closest match; read `rules/project-rules.md` + `rules/coding-standards.md`; match by workflow filename or proceed with Always Read; triggers: "other unlisted task"
<!-- ROUTING_SUMMARY_END -->

</task-routing>

## Known Gotchas

- **Editor popup keepalive** — any popup from the custom inline editor must hold `openPopup()` / `closePopup()`; otherwise blur unmounts it and mutations silently no-op. See `references/agents/frontend.md#custom-inline-editor--popup-keepalive-invariant`.
- **Race condition triage** — if a local change disappears after a network mutation, check the debounced save / query invalidation boundary first. See `gotchas/index.md#race-condition-triage`.
- **Operation log immutability** — fix bad data by appending new operations, never by editing envelopes or adding client-side backward-compatibility shims. See `gotchas/index.md#operation-log-immutability`.

## Core Principles

1. **Operation log is the source of truth.** All state changes append operations; derived tables and client SQLite are views.
   ✓ Check: does this change mutate derived storage directly, or does it go through the operation log / relay?
2. **Fix root causes, not symptoms.** Bad data gets a migration; code does not tolerate bad data.
   ✓ Check: is there a migration or operation-log append that fixes the underlying data?
3. **Verify before finishing.** Run lint/tests and, for runtime changes, rebuild the dev stack and confirm in the browser.
   ✓ Check: what command or manual check proves this change is safe?
4. **No cross-layer imports.** UI code does not reach data access directly; backend services use ports, not FastAPI/asyncpg.
   ✓ Check: does any new import cross a layer boundary?

## Rule Priority

1. `skills/notees/SKILL.md`
2. `skills/notees/rules/`
3. `skills/notees/workflows/`
4. `skills/notees/references/`
5. Root `README.md`
6. Thin shells (`AGENTS.md`, etc.) — compatibility only

## Project Boundaries

- **Owned**: FastAPI backend, React frontend, operation log, relay sync, tests, build/release, agent docs in this repo.
- **Not owned**: Flutter mobile app (separate repo `miquelrosell99/notees-flutter`).
- **User docs** live in `docs/`; do not put agent reference or plans there.
