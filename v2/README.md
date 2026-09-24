# Notees v2 (greenfield)

Local-first object graph for personal knowledge: operation log, derived SQLite, first-class relations.

- **Plan / decision record**: `docs/plans/2026-09-24-object-graph-pim-evolution/assessment.md` (§34 is the active plan).
- **First artifact**: `packages/protocol/RELATIONS.md` — the Relation Semantics Specification. Read it before touching relation code.
- **Protocol**: v2 envelopes, camelCase, `protocolVersion: 2`, provenance claims (`deviceId`, `client`), M3 encryption slot (`{"$e": …}`).

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
