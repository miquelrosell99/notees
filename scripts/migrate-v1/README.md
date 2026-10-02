# migrate-v1 — v1 → v2 workspace migrator

Transforms v1 relay envelopes into v2 envelopes and replays them per workspace
into the production v2 server (`notees-sync` at `http://localhost:8377`).

## Layout

- `extract.py` — streams the three non-empty v1 workspaces from the v1 dev
  Postgres container (`notees-db-dev`) via `psql COPY` into
  `.extract/<workspace-uuid>.jsonl` (original v1 column names, timestamps
  normalized to ISO-8601 UTC). Also writes `.extract/meta.json`.
- `content_ast.py` — Python port of the legacy-AST→flat-token conversion
  (`notees-flutter/lib/core/utils/ast_stringifier.dart`, B2 normalizeContentAst)
  plus v1's class-name normalization (`app/core/derived/class.py`).
- `migrate.py` — the migrator: transform (`dry-run` / `apply`), batch push,
  asset copy, verification, `report.json`.
- `validate.mjs` — offline validation of every transformed envelope against
  the real `@notees/protocol` zod schemas (same checks as the server's
  `/batch` endpoint).
- `report.json` — the last run's full report.
- `.extract/` — extracted v1 JSONL + transformed v2 JSONL (`.v2.jsonl`).

## Usage

```sh
python3 extract.py          # refresh .extract/ from the v1 database
python3 migrate.py dry-run  # transform + report, push NOTHING
node validate.mjs           # offline check against the real v2 schemas
python3 migrate.py apply    # seed workspaces, push in batches of 500, copy
                            # assets, verify; writes report.json
```

`apply` is idempotent: transformed envelope ids are the original v1 ids
(companion-op ids are uuid5 hashes of the v1 id + suffix), and the v2 relay
dedupes by envelope id.

## Mapping decisions worth knowing

See the module docstring in `migrate.py` for the verified v1 payload shapes
(sampled per op type before writing the transformer). Notable behaviors:

- Envelopes keep id/HLC/timestamp/actorId; `protocolVersion: 3`,
  `deviceId: "migrated-v1"`, `client: "migrate-v1"`.
- Non-uuid v1 actor ids (migration backfills) are remapped to the uuid
  embedded in them.
- v1 class/propertySchema ops whose ids collide with the v2 workspace seed
  are dropped (the seed already created them with newer HLCs; replaying would
  clobber seed rows). Only ids the seed actually emits count — the UUID map
  also lists unseeded classes (warning/tip/info/danger/success) which replay
  from the log. User renames of seeded classes are not carried over.
- All create envelopes are emitted FIRST (classes, then nodes in a stable
  topological order — parents before children), then everything else in
  original seq order. v1 tolerated child-before-parent logs; v2's object.create
  requires the parent to exist. Duplicate re-creates trail their first
  occurrence (v2 is first-create-wins, matching v1's INSERT OR IGNORE).
- `class.create.extends` becomes a `class.setExtends` companion emitted at the
  end of the stream (all classes exist by then).
- `node.move` positions are simulated as per-parent ordered lists
  (fractional v1 indices rounded to slots); the v2 `afterId` is the element
  now at `newIndex-1`. Server-side HLC gating is authoritative for the final
  order (v1 seq order has ~2.4k HLC inversions on the big workspace).
- v1 `node.delete` hard-deletes a single node row; v2 has no single-node hard
  delete and no revive op. Deletes superseded by a later re-create are
  dropped; the rest map to v2 soft delete (trash) so later ops keep applying
  and descendant content survives.
- `node.updateContent` ops carrying only CRDT binary updates
  (`textUpdateB64` / `textUpdate` / `treeUpdate`) with no readable mirror are
  counted and skipped.
- Nodes v1 parented under class nodes (6 creates, 6 moves) cannot exist in v2
  (classes are tree-external): creates migrate as root pages, moves are
  skipped.
- The v1 asset-migration schema id `file-schema-<workspace>` (not a uuid) is
  remapped to a deterministic uuid with a synthesized
  `propertySchema.create` (type `image`).
