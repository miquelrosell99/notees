# Relation Semantics Specification (RELATIONS.md)

Status: **v1, approved for M1 implementation** · Owner: `packages/protocol` · Consumers: `packages/domain`, `packages/store`, `packages/sync`, `packages/query`, `apps/*`

This document is the normative specification for first-class relations in Notees v2, derived from the assessment (§14) and locked by decision record D1–D5 (assessment §34.1). It is the first artifact of the greenfield repository: implementation code for relations MUST NOT be written before the fixtures in this document exist.

Implementation mapping (locked):

- **M1 implements dimensions 1–5 and 8–9**, plus the `relation_schema` table and the hardcoded system seed set (§0).
- **M2 implements dimensions 6 (ordering), 7 (schema evolution), and 10's `relation_path` conditions.** They are specified here so they are never re-litigated; they are not built in M1.

---

## 0. Seed set and fixed UUIDs (M1)

Seeded relation schemas MUST use **stable, fixed UUIDs in seed data — never names or generated ids.** Relation rows reference `relation_schema_id`; the canonical fixtures and the old-data migration script bake these ids in. Seed-id drift silently breaks both.

UUID block `00000000-0000-0000-0004-…` is reserved for system relation schemas (the `0001` block is system classes, `0002` system pages, `0003` task properties in the legacy system — precedent: `SYSTEM_CLASS_UUIDS`, `app/domain/entities/constants.py`).

| Name | Fixed UUID | Inverse name | Source filter | Target filter |
|---|---|---|---|---|
| `authored-by` | `00000000-0000-0000-0004-000000000001` | `author-of` | any | `agent` descendants |
| `published-by` | `00000000-0000-0000-0004-000000000002` | `publisher-of` | `source` descendants | `organization` |
| `edition-of` | `00000000-0000-0000-0004-000000000003` | `has-edition` | any | any |
| `cites` | `00000000-0000-0000-0004-000000000004` | `cited-by` | any | `source` descendants |
| `related-to` | `00000000-0000-0000-0004-000000000005` | `related-to` (symmetric) | any | any |
| `has-asset` | `00000000-0000-0000-0004-000000000006` | `asset-of` | any | `asset` |
| `annotates` | `00000000-0000-0000-0004-000000000007` | `annotated-by` | `annotation` | `asset` |
| `member-of` | `00000000-0000-0000-0004-000000000008` | `has-member` | any | `collection` |
| `about` | `00000000-0000-0000-0004-000000000009` | `has-note` | `note` | any |
| `mentions` | `00000000-0000-0000-0004-00000000000a` | `mentioned-in` | any | any |

User-defined relation schemas (M2, `relationSchema.create`) receive ordinary UUIDv7 ids and never collide with this block.

## 1. Identity

- Relation id = **UUIDv7**, client-assigned at creation, globally unique, immutable.
- The triple `(sourceId, relationSchemaId, targetId)` is unique per workspace after dedupe (dimension 3).
- Ids are never derived from names, titles, or positions.

## 2. Deletion

- `relation.delete` carries only `relationId` (+ envelope metadata). The applier writes a tombstone: `relation_tombstone(id PK, hlc_physical, hlc_logical, actor_id, deleted_at)`.
- Re-creating an identical `(source, schema, target)` triple after deletion creates a **new** relation id. Tombstones are never resurrected.
- Deletion requires write permission on the **source** object (dimension 8).

## 3. Concurrent creation

- Two `relation.create` ops for the same triple racing across devices converge to **one** row: the applier keeps the row with the lowest `(hlc_physical, hlc_logical, id)`; the loser is discarded (not tombstoned — it never existed semantically).
- The surviving row's `properties` are the winner's properties (they are identical at creation; divergence only via `relation.update`).

## 4. Concurrent delete/update

- **Delete wins.** A `relation.delete` tombstone dominates any `relation.update` whose HLC is not strictly greater… in fact even then: once tombstoned, updates to that relation id are no-ops on every replica (the relation is gone; properties are moot).
- The applier flags `relation_conflict` (same relation id touched by concurrent delete and update from different actors) so the UI can surface "a relation you edited was deleted elsewhere" — detection only, no merge.

## 5. Property updates (LWW)

- `relation.update` payload: `{relationId, properties: Record<string, unknown>}` — **partial** update, per-key last-writer-wins by HLC `(physical, logical, actor_id)` as tiebreak.
- Property keys are defined by the relation schema's `propertiesSchema` (M2 validates; M1 stores opaque JSON).
- Concurrent updates to *different* keys merge; to the *same* key, higher HLC wins.

## 6. Ordering (M2)

- `position: string` (fractional-index style) scoped per `(sourceId, relationSchemaId)`.
- Concurrent reorders: LWW on the ordered set — each replica orders by `position`, ties by relation id; no CRDT sequence semantics.
- M1 payloads MUST NOT include `position`; appliers ignore it if present (forward-compat).

## 7. Schema evolution (M2)

- Deleting a relation schema with live relations: relations remain, rendered by raw schema name. **Never cascade-delete user data.**
- Recreating a schema with the same name does not re-bind old relations (binding is by id).
- `relationSchema.update` may change `propertiesSchema`; existing relation properties are not retroactively validated.

## 8. Permissions

- Relation write (create/update/delete) requires **write access to the source object**; target-side checks are best-effort only (consistent with the trust model: workspace membership is the real boundary; routing metadata is client-supplied).
- Read access to a relation follows read access to its source.

## 9. Inverse traversal and edge projection

- The derived store maintains an `edge` projection: every live relation emits two rows — forward `(source, schema, target)` and inverse `(target, schema⁻¹, source)` where `schema⁻¹ = inverseName`.
- Backlinks, graph views, and counts read the projection, never the `relation` table directly.
- `relation.delete` removes both projection rows; recreation re-adds them under the new id.

## 10. Query and UI (compiler surface)

- QueryAST gains `relation` (M1) and `relation_path` (M2) conditions:
  - `relation`: `source|target` direction, schema id (or name), optional property predicates.
  - `relation_path`: recursive traversal over the edge projection, `maxDepth` capped (default 3), cycle-safe.
- UI: object pages show outgoing/incoming relation sections; creation dialogs offer the seeded schema set with target class filters from §0.

## 11. Interaction with citations and annotations

- `cites`, `annotates`, `about`, `mentions` are ordinary relation schemas — **no special-case sync semantics**. Citation locators (`locator`, `prefix`, `suffix`, `position`) are relation *properties* under dimension 5's LWW rules.
- Annotations (M2) are objects classed `annotation`; their asset anchoring is expressed via `annotates` relations plus annotation property schemas.

---

## Fixtures (normative)

Every fixture lives in `packages/protocol/fixtures/` and is validated by `packages/protocol/test/fixtures.test.ts`. Required at M1:

| Fixture | Asserts |
|---|---|
| `envelope-minimal.json` | v2 envelope shape, camelCase, `protocolVersion: 2`, `client`/`deviceId` claims present |
| `object-create.json` | `object.create` payload schema |
| `relation-create.json` | `relation.create` with seeded `cites` UUID `00000000-0000-0000-0004-000000000004` and `properties.locator` |
| `relation-delete.json` | `relation.delete` tombstone payload |
| `relation-concurrent-create.json` | two creates of the same triple → convergence to lowest HLC+id (applier test, M1) |

Rules: fixtures are camelCase JSON; ids in fixtures are real UUIDv7 (seed UUIDs excepted — they are fixed by §0); an op type is not "implemented" until its fixture validates against both the envelope schema and its payload schema in the same test run that the appliers pass.
