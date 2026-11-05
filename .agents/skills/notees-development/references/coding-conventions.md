# Coding conventions

Canonical: `docs/developers/development.md` and
`docs/developers/ui-primitives.md`. Package-level TypeScript conventions:
the fleet `typescript-conventions` skill.

## Language + module rules

- TS 5.6 **strict** (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), ES2022, bundler module resolution, ESM only
  with explicit `.js` suffixes on relative imports.
- Packages export raw TS (`"exports": { ".": "./src/index.ts" }`,
  dev condition) — only deployables (server/web Docker images) bundle. This is
  why vitest reads `src` but `tsc` reads `dist` (rebuild dist before
  typechecking dependents after an API change).
- zod strict everywhere (wire envelopes, API bodies, QueryAST).
- Naming: camelCase on the wire, snake_case in DB columns/tables.
- SQL: positional `?` params only; no AUTOINCREMENT in the derived schema —
  derived ids are content hashes (determinism: wipe → replay → identical).
- Comments point at the spec they implement (e.g. `// see SCHEMA.md`).

## Commits

Conventional Commits: `feat(web): …`, `fix(server): …` style.
Never re-tag a release; same-day correction = next patch tag.

## Web UI primitives law — MOVED

Repo split 2026-11-05: the web UI laws (ui-kit composition, token-only CSS,
the popup-dismissal seam, view surfaces owning their URL/tab title,
chrome-row layout contracts) bind only in the `notees-web` repo — see its
`AGENTS.md` + `docs/developers/ui-primitives.md`. This repo has no app chrome.

