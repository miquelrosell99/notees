/**
 * Effective-values read model (SCHEMA.md "Class properties"): the per-node
 * property view the panel and queries read through.
 *
 *   effective(node, schema, idx) = authored property_value
 *                                  ?? winning binding's defaultValue
 *
 * Authored rows always win and survive class removal (design law); derived
 * defaults are computed HERE, never materialized — the applier writes no
 * property_value rows for them, which gives convergence and cleanup for free.
 * Authored rows come through the PG5 visible-set derivation
 * (property-values.ts: slot tombstones + element tombstones) and carry their
 * stable element id. Binding conflicts resolve per the SCHEMA.md diamond rule
 * (PG4): OWN bindings first (first-class-applied-wins — the class
 * whose OR-Set membership add carries the earliest HLC, exact ties by class
 * id), then INHERITED bindings by shortest extends-path (BFS over
 * class_extends; the class itself is distance 0), ties by the same assignment
 * order — and only ACTIVE rows are candidates (PC4: an inactive binding stops
 * contributing defaults + metadata while authored values survive, read as
 * unbound). Deterministic on every replica — a pure read over derived tables,
 * no writes, no clocks.
 */

import { isValidDefaultForType, visiblePropertyValueRows } from "./property-values.js";
import type { SqliteDB } from "./db.js";

export interface EffectivePropertySchema {
  id: string;
  name: string;
  type: string;
  multi: boolean;
  /** SCHEMA.md "Dates": finest granularity a date value may claim (NULL = day). */
  datePrecision: "year" | "month" | "day" | null;
  /** SCHEMA.md "Dates": node-typed values may carry date qualifiers. */
  dateQualified: boolean | null;
  /** SCHEMA.md "Number formats": display-only formatting (NULL = unformatted). */
  numberPad: number | null;
  numberDecimals: number | null;
  numberRounding: "round" | "floor" | "ceil" | "truncate" | null;
  /** PROPERTY-level render contracts (NULL = panel / unset). */
  display: "panel" | "bullet" | "inline" | null;
  readonly: boolean | null;
  hideWhenEmpty: boolean | null;
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
  /** PG5: the value's stable element id (the property_value row id) — the
   *  address multi-value removes target. */
  elementId: string;
  schema: EffectivePropertySchema | null;
  value: unknown;
  /** Authored qualifiers (property.set metadata — PC6 date refs or legacy
   *  ISO strings on dateQualified schemas); null for derived defaults. */
  metadata: Record<string, unknown> | null;
  source: "authored" | "default";
  boundBy: string | null;
  /** Per-CLASS: the winning binding's required flag — a property
   *  may be mandatory for one class, optional for another. */
  required: boolean | null;
  /** PROPERTY-level: the schema's render contracts — the same for
   *  every carrier, class-bound or not. */
  readonly: boolean | null;
  hideWhenEmpty: boolean | null;
  sequence: number | null;
  display: "panel" | "bullet" | "inline" | null;
}

interface AuthoredRow {
  id: string;
  property_schema_id: string;
  value: string;
  idx: number;
  metadata: string | null;
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
/** Sanitize the stored position (NULL/unknown = the "panel" default). */
const displayOf = (v: string | null): "panel" | "bullet" | "inline" | null =>
  v === "bullet" || v === "inline" ? v : null;

export function getEffectiveProperties(db: SqliteDB, nodeId: string): EffectiveProperty[] {
  // 1. Authored rows through the PG5 visible-set derivation (property-values.ts):
  //    live rows minus slot tombstones minus element tombstones — the same
  //    rule the applier enforces on write.
  const authoredRows = visiblePropertyValueRows(db, nodeId) as unknown as AuthoredRow[];

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

  // 3. Winning binding per schema, extends-aware (SCHEMA.md diamond rule):
  //    candidates are (class, ancestor) pairs where the ancestor's
  //    class_property row binds the schema, discovered by BFS over
  //    class_extends (the class itself is distance 0 = own binding — the
  //    class_hierarchy closure carries no distance, so shortest-path walks
  //    the edge table). The winner minimizes (distance, assignment HLC,
  //    class id); boundBy names the ANCESTOR whose row supplies the
  //    binding + default. With no extends edges this reduces exactly to
  //    first-class-applied-wins over own bindings.
  interface BindingRow {
    property_schema_id: string;
    sequence: number;
    required: number | null;
    default_value: string | null;
  }
  interface BindingCandidate {
    distance: number;
    physical: number;
    logical: number;
    classId: string;
    ancestorId: string;
    binding: BindingRow;
  }
  const extendsStmt = db.prepare(
    "SELECT parent_class_id FROM class_extends WHERE class_id = ?",
  );
  const reachCache = new Map<string, Array<{ ancestorId: string; distance: number }>>();
  const reachOf = (classId: string): Array<{ ancestorId: string; distance: number }> => {
    const cached = reachCache.get(classId);
    if (cached) return cached;
    const visited = new Set<string>([classId]);
    const queue: Array<{ id: string; distance: number }> = [{ id: classId, distance: 0 }];
    const reach: Array<{ ancestorId: string; distance: number }> = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      reach.push({ ancestorId: current.id, distance: current.distance });
      for (const row of extendsStmt.all(current.id) as Array<{ parent_class_id: string }>) {
        if (visited.has(row.parent_class_id)) continue;
        visited.add(row.parent_class_id);
        queue.push({ id: row.parent_class_id, distance: current.distance + 1 });
      }
    }
    reachCache.set(classId, reach);
    return reach;
  };
  const bindingStmt = db.prepare(
    `SELECT property_schema_id, sequence, required, default_value
     FROM class_property WHERE class_id = ? AND active = 1`,
  );
  const candidatesBySchema = new Map<string, BindingCandidate[]>();
  for (const cls of classes) {
    for (const reach of reachOf(cls.class_id)) {
      for (const binding of bindingStmt.all(reach.ancestorId) as unknown as BindingRow[]) {
        const list = candidatesBySchema.get(binding.property_schema_id);
        const candidate: BindingCandidate = {
          distance: reach.distance,
          physical: cls.hlc_physical,
          logical: cls.hlc_logical,
          classId: cls.class_id,
          ancestorId: reach.ancestorId,
          binding,
        };
        if (list) list.push(candidate);
        else candidatesBySchema.set(binding.property_schema_id, [candidate]);
      }
    }
  }
  const winnerBySchema = new Map<string, { classId: string; binding: BindingRow }>();
  for (const [schemaId, candidates] of candidatesBySchema) {
    candidates.sort(
      (a, b) =>
        a.distance - b.distance ||
        a.physical - b.physical ||
        a.logical - b.logical ||
        (a.classId < b.classId ? -1 : 1),
    );
    const winner = candidates[0]!;
    winnerBySchema.set(schemaId, { classId: winner.ancestorId, binding: winner.binding });
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
        `SELECT id, name, type, multi, date_precision, date_qualified,
                number_pad, number_decimals, number_rounding,
                display, readonly, hide_when_empty
         FROM property_schema WHERE id IN (${placeholders})`,
      )
      .all(...schemaIds) as Array<{
      id: string;
      name: string;
      type: string;
      multi: number;
      date_precision: string | null;
      date_qualified: number | null;
      number_pad: number | null;
      number_decimals: number | null;
      number_rounding: string | null;
      display: string | null;
      readonly: number | null;
      hide_when_empty: number | null;
    }>;
    for (const row of rows) {
      schemas.set(row.id, {
        id: row.id,
        name: row.name,
        type: row.type,
        multi: row.multi === 1,
        datePrecision:
          row.date_precision === "year" || row.date_precision === "month" || row.date_precision === "day"
            ? row.date_precision
            : null,
        dateQualified: row.date_qualified === null ? null : row.date_qualified === 1,
        numberPad: row.number_pad === null || row.number_pad === undefined ? null : Number(row.number_pad),
        numberDecimals:
          row.number_decimals === null || row.number_decimals === undefined ? null : Number(row.number_decimals),
        numberRounding:
          row.number_rounding === "round" || row.number_rounding === "floor" || row.number_rounding === "ceil" || row.number_rounding === "truncate"
            ? row.number_rounding
            : null,
        display: displayOf(row.display),
        readonly: flag(row.readonly),
        hideWhenEmpty: flag(row.hide_when_empty),
      });
    }
  }

  // 5. Merge: authored wins per (schema, idx, ELEMENT — PG5: rows at the same
  //    idx are distinct elements and all surface); a winning ACTIVE binding
  //    (PC4 — inactive rows never became candidates) with a default and NO
  //    authored value at idx 0 derives a default row.
  const rows = new Map<string, EffectiveProperty>();
  const push = (key: string, row: EffectiveProperty): void => {
    rows.set(key, row);
  };
  const shadowedDefaultSchemas = new Set<string>();

  for (const authored of authoredRows) {
    const winner = winnerBySchema.get(authored.property_schema_id);
    const schema = schemas.get(authored.property_schema_id) ?? null;
    if (authored.idx === 0) shadowedDefaultSchemas.add(authored.property_schema_id);
    push(`${authored.property_schema_id}:${authored.idx}:${authored.id}`, {
      propertySchemaId: authored.property_schema_id,
      idx: authored.idx,
      elementId: authored.id,
      schema,
      value: parseJson(authored.value),
      metadata: authored.metadata !== null ? (parseJson(authored.metadata) as Record<string, unknown>) : null,
      source: "authored",
      boundBy: winner?.classId ?? null,
      // Required is per-CLASS (the winning binding); readonly/
      // hideWhenEmpty/display are per-PROPERTY (the schema — unbound values
      // included, the owner's multi-class/unbound cases).
      required: winner ? flag(winner.binding.required) : null,
      readonly: schema?.readonly ?? null,
      hideWhenEmpty: schema?.hideWhenEmpty ?? null,
      sequence: winner ? winner.binding.sequence : null,
      display: schema?.display ?? null,
    });
  }

  for (const [schemaId, winner] of winnerBySchema) {
    const { binding, classId } = winner;
    if (binding.default_value === null) continue; // bound without a default
    // PC2 read-side: a stored default that no longer matches the schema
    // type (written before validation, or after a delete+recreate changed
    // the type) yields no default rather than a wrong-typed value.
    const schema = schemas.get(schemaId);
    if (schema && !isValidDefaultForType(schema.type, parseJson(binding.default_value))) continue;
    if (shadowedDefaultSchemas.has(schemaId)) continue; // authored at idx 0 shadows the default
    push(`${schemaId}:0:default`, {
      propertySchemaId: schemaId,
      idx: 0,
      elementId: `default:${schemaId}:0`,
      schema: schema ?? null,
      value: parseJson(binding.default_value),
      metadata: null,
      source: "default",
      boundBy: classId,
      required: flag(binding.required),
      readonly: schema?.readonly ?? null,
      hideWhenEmpty: schema?.hideWhenEmpty ?? null,
      sequence: binding.sequence,
      display: schema?.display ?? null,
    });
  }

  // 6. Deterministic presentation order: bound rows by binding sequence,
  //    unbound authored rows last; schema name then (idx, element id) as the
  //    tiebreak (PG5: concurrent adds may share an idx — the element id
  //    orders them identically on every replica).
  const nameOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;
  return [...rows.values()].sort((a, b) => {
    const boundDelta = (a.boundBy === null ? 1 : 0) - (b.boundBy === null ? 1 : 0);
    if (boundDelta !== 0) return boundDelta;
    const seqDelta = (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER);
    if (seqDelta !== 0) return seqDelta;
    const nameDelta = nameOf(a).localeCompare(nameOf(b));
    if (nameDelta !== 0) return nameDelta;
    const idxDelta = a.idx - b.idx;
    if (idxDelta !== 0) return idxDelta;
    return a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0;
  });
}
