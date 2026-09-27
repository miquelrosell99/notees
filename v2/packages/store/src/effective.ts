/**
 * Effective-values read model (SCHEMA.md "Class properties"): the per-node
 * property view the panel and (M2) queries read through.
 *
 *   effective(node, schema, idx) = authored property_value
 *                                  ?? winning binding's defaultValue
 *
 * Authored rows always win and survive class removal (design law); derived
 * defaults are computed HERE, never materialized — the applier writes no
 * property_value rows for them, which gives convergence and cleanup for free.
 * Binding conflicts across the node's classes resolve first-class-applied-wins:
 * the class whose OR-Set membership add carries the earliest HLC supplies the
 * default AND the binding metadata (sequence/required/readonly/hideWhenEmpty);
 * exact HLC ties break by class id. Deterministic on every replica — a pure
 * read over derived tables, no writes, no clocks.
 */

import { compareLww } from "./appliers.js";
import type { SqliteDB } from "./db.js";

export interface EffectivePropertySchema {
  id: string;
  name: string;
  type: string;
  multi: boolean;
}

/**
 * One effective (schema, idx) row for a node. `source` tags authored vs
 * derived; `boundBy` is the class supplying the binding metadata — the
 * winning class for a default, the currently-binding class for an authored
 * row, or null when no current class binds the schema (an authored value
 * whose binding went away stays visible, marked unbound).
 */
export interface EffectiveProperty {
  propertySchemaId: string;
  idx: number;
  schema: EffectivePropertySchema | null;
  value: unknown;
  /** Authored qualifiers (property.set metadata); null for derived defaults. */
  metadata: Record<string, unknown> | null;
  source: "authored" | "default";
  boundBy: string | null;
  required: boolean | null;
  readonly: boolean | null;
  hideWhenEmpty: boolean | null;
  sequence: number | null;
}

interface LwwRow {
  hlc_physical: number;
  hlc_logical: number;
  actor_id: string | null;
}

function rowWinner(row: LwwRow) {
  return { physical: row.hlc_physical, logical: row.hlc_logical, actor: row.actor_id ?? "" };
}

interface AuthoredRow {
  property_schema_id: string;
  value: string;
  idx: number;
  metadata: string | null;
  hlc_physical: number;
  hlc_logical: number;
  actor_id: string | null;
}

interface TombstoneRow {
  property_schema_id: string;
  idx: number;
  hlc_physical: number;
  hlc_logical: number;
  actor_id: string | null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const flag = (v: number | null): boolean | null => (v === null || v === undefined ? null : v === 1);

export function getEffectiveProperties(db: SqliteDB, nodeId: string): EffectiveProperty[] {
  // 1. Authored rows, tombstone-suppressed with the same rule the applier
  //    enforces on write: a tombstone with >= (hlc, actor) blocks the value.
  const authoredRows = db
    .prepare(
      `SELECT property_schema_id, value, idx, metadata, hlc_physical, hlc_logical, actor_id
       FROM property_value WHERE node_id = ?`,
    )
    .all(nodeId) as unknown as AuthoredRow[];
  const tombstones = db
    .prepare(
      `SELECT property_schema_id, idx, hlc_physical, hlc_logical, actor_id
       FROM property_value_tombstone WHERE node_id = ?`,
    )
    .all(nodeId) as unknown as TombstoneRow[];
  const suppressed = (row: AuthoredRow): boolean =>
    tombstones.some(
      (t) =>
        t.property_schema_id === row.property_schema_id &&
        t.idx === row.idx &&
        compareLww(rowWinner(row), rowWinner(t)) <= 0,
    );

  // 2. The node's classes in assignment order: OR-Set add HLC ascending
  //    (earliest first), ties by class id.
  const classes = (
    db
      .prepare(
        `SELECT class_id, hlc_physical, hlc_logical
         FROM class_member_set WHERE node_id = ? AND present = 1`,
      )
      .all(nodeId) as Array<{ class_id: string; hlc_physical: number; hlc_logical: number }>
  ).sort(
    (a, b) =>
      a.hlc_physical - b.hlc_physical ||
      a.hlc_logical - b.hlc_logical ||
      (a.class_id < b.class_id ? -1 : 1),
  );

  // 3. Winning binding per schema: first class (in assignment order) that
  //    binds the schema supplies default + metadata.
  interface BindingRow {
    property_schema_id: string;
    sequence: number;
    required: number | null;
    readonly: number | null;
    hide_when_empty: number | null;
    default_value: string | null;
  }
  const winnerBySchema = new Map<string, { classId: string; binding: BindingRow }>();
  const bindingStmt = db.prepare(
    `SELECT property_schema_id, sequence, required, readonly, hide_when_empty, default_value
     FROM class_property WHERE class_id = ?`,
  );
  for (const cls of classes) {
    for (const binding of bindingStmt.all(cls.class_id) as unknown as BindingRow[]) {
      if (!winnerBySchema.has(binding.property_schema_id)) {
        winnerBySchema.set(binding.property_schema_id, { classId: cls.class_id, binding });
      }
    }
  }

  // 4. Schema rows for everything referenced (authored rows survive schema
  //    deletion: the row renders with schema = null).
  const schemaIds = new Set<string>([
    ...authoredRows.map((r) => r.property_schema_id),
    ...winnerBySchema.keys(),
  ]);
  const schemas = new Map<string, EffectivePropertySchema>();
  if (schemaIds.size > 0) {
    const placeholders = [...schemaIds].map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, name, type, multi FROM property_schema WHERE id IN (${placeholders})`,
      )
      .all(...schemaIds) as Array<{ id: string; name: string; type: string; multi: number }>;
    for (const row of rows) {
      schemas.set(row.id, { id: row.id, name: row.name, type: row.type, multi: row.multi === 1 });
    }
  }

  // 5. Merge: authored wins per (schema, idx); a winning binding with a
  //    default and NO authored value at idx 0 derives a default row.
  const rows = new Map<string, EffectiveProperty>();
  const push = (key: string, row: EffectiveProperty): void => {
    rows.set(key, row);
  };

  for (const authored of authoredRows) {
    if (suppressed(authored)) continue;
    const winner = winnerBySchema.get(authored.property_schema_id);
    push(`${authored.property_schema_id}:${authored.idx}`, {
      propertySchemaId: authored.property_schema_id,
      idx: authored.idx,
      schema: schemas.get(authored.property_schema_id) ?? null,
      value: parseJson(authored.value),
      metadata: authored.metadata !== null ? (parseJson(authored.metadata) as Record<string, unknown>) : null,
      source: "authored",
      boundBy: winner?.classId ?? null,
      required: winner ? flag(winner.binding.required) : null,
      readonly: winner ? flag(winner.binding.readonly) : null,
      hideWhenEmpty: winner ? flag(winner.binding.hide_when_empty) : null,
      sequence: winner ? winner.binding.sequence : null,
    });
  }

  for (const [schemaId, winner] of winnerBySchema) {
    const { binding, classId } = winner;
    if (binding.default_value === null) continue; // bound without a default
    const key = `${schemaId}:0`;
    if (rows.has(key)) continue; // authored value at idx 0 shadows the default
    push(key, {
      propertySchemaId: schemaId,
      idx: 0,
      schema: schemas.get(schemaId) ?? null,
      value: parseJson(binding.default_value),
      metadata: null,
      source: "default",
      boundBy: classId,
      required: flag(binding.required),
      readonly: flag(binding.readonly),
      hideWhenEmpty: flag(binding.hide_when_empty),
      sequence: binding.sequence,
    });
  }

  // 6. Deterministic presentation order: bound rows by binding sequence,
  //    unbound authored rows last; schema name then idx as the tiebreak.
  const nameOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;
  return [...rows.values()].sort((a, b) => {
    const boundDelta = (a.boundBy === null ? 1 : 0) - (b.boundBy === null ? 1 : 0);
    if (boundDelta !== 0) return boundDelta;
    const seqDelta = (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER);
    if (seqDelta !== 0) return seqDelta;
    const nameDelta = nameOf(a).localeCompare(nameOf(b));
    if (nameDelta !== 0) return nameDelta;
    return a.idx - b.idx;
  });
}
