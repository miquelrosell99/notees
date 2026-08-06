# References — Notees

Code maps, background material, and detailed subsystem docs. Use the tier hubs (`architecture/`, `conventions/`, `gotchas/`) for task routing; this index is for discovery.

## Project Meta

- `project-structure.md` — directory layout and documentation boundaries
- `tech-stack.md` — languages, frameworks, versions
- `build-and-test.md` — verification commands and dev workflow

## Legacy Agent Docs (migrated from `agents/`)

The previous `agents/` tree now lives under `references/agents/`.

### Architecture & Data Model

- `agents/backend.md` — backend architecture and patterns
- `agents/data-model.md` — data model, identifier strategy, domain conventions
- `agents/plugin-system.md` — plugin architecture
- `agents/subsystems.md` — graph view, QueryAST client-side evaluation, block editor, service worker/PWA, asset uploads

### Frontend & UI

- `agents/frontend.md` — frontend architecture and conventions
- `agents/building-blocks.md` — composable UI primitives inventory and layering model
- `agents/design-language.md` — full design language

### Operations, Security, Release

- `agents/operations.md` — debugging, verification, performance, linting, config, pitfalls
- `agents/security-and-rate-limiting.md` — security defaults and rate limiting
- `agents/testing.md` — testing strategy and E2E (Playwright)
- `agents/build-and-release.md` — build, dev, release, and deployment
- `agents/mobile-sync.md` — mobile sync validation notes
- `agents/agent-api.md` — agent API conventions

### Plans & Reports

- `agents/plans/` — implementation plans and working documents
- `agents/superpowers/plans/` — superpowers workflow artifacts
- `agents/superpowers/specs/` — superpowers design specs
- `agents/crdt-spike-report.md` — CRDT spike report

## Skill Meta

- `agent-behavior-meta.md` — rationale for agent-behavior defaults
- `behavior-failures.md` — recorded behavior failures
- `permission-model.md` — skill permission model
- `subagent-verification.md` — subagent verification notes
- `tests-as-spec.md` — tests-as-spec reference
