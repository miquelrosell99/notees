# Notees v2 (greenfield)

Local-first object graph for personal knowledge: operation log, derived SQLite, three information layers (properties / typed-link marks / prose) over one edge index.

- **Model (normative)**: `docs/design/01-knowledge-model.md` (+ `00-INDEX.md`, `02`, `03`). Precedence: `01` wins on model questions; the plan (`docs/plans/2026-09-24-object-graph-pim-evolution/assessment.md`) wins on process/milestones/gates.
- **First artifact**: `packages/protocol/SCHEMA.md` — property-schema, class-structure, and typed-link token spec (owed-work register; record-don't-resolve).
- **Protocol**: v2 envelopes, camelCase, `protocolVersion: 2`, provenance claims (`deviceId`, `client`), M3 encryption slot (`{"$e": …}`). No `relation.*` ops — associations are property values or typed-link word marks.

## Layout

- `packages/protocol` — envelopes, HLC, op registry, seed relation schemas, canonical fixtures.
- `packages/domain`, `packages/store`, `packages/sync`, `packages/query`, `packages/search`, `packages/editor`, `packages/api-client`, `packages/plugin-sdk` — see assessment §34.3 (landed per milestone).
- `apps/server`, `apps/web`, `apps/cli` — see assessment §34.6 (M1).

## Commands

```bash
pnpm install
pnpm test        # all packages
pnpm typecheck   # all packages
```
