/**
 * Effective-values read model (SCHEMA.md "Class properties"): the per-node
 * property view the panel and queries read through.
 *
 *   effective(node, schema, idx) = authored property_value
 *                                  ?? the SCHEMA's defaultValue
 *                                  ?? an ASSIGNED empty row (value null)
 *                                  ?? a BOUND-but-empty row (value null)
 *
 * Authored rows always win and survive class removal (design law); derived
 * defaults are computed HERE, never materialized — the applier writes no
 * property_value rows for them, which gives convergence and cleanup for free.
 * The default is SCHEMA-level (owner ruling 2026-10-20 — one global default
 * per property, the Logseq shape): a winning ACTIVE binding still decides
 * WHICH properties a class's nodes carry (and supplies boundBy),
 * but the default VALUE comes from the schema row. Presentation order is
 * PURE ALPHABETICAL by property name (owner ruling 2026-10-21 — `sequence`
 * retired from the binding; class panels have no configurable order);
 * UNBOUND AUTHORED rows (a value whose binding went away — never hidden,
 * the not-retroactive law) sort after every bound/assigned/default row.
 * A node-level ASSIGNMENT (owner ruling 2026-10-23 — the v1 `node_property`
 * lineage) with no authored rows and no derived default synthesizes an
 * EMPTY row (value null, source "assigned"): the panel renders it and the
 * row's editor authors the first value through an ordinary property.set —
 * assignment and value authoring are independent by design. A winning
 * ACTIVE binding with nothing on the slot synthesizes the BOUND-but-empty
 * row (value null, source "bound", boundBy naming the binder): the virtual
 * property shows as coming from the class until realized or valued — the
 * virtual/realized assessment's "they should still show up as coming from
 * the class", scalar types included.
 * Authored rows come
 * through the PG5 visible-set derivation
 * (property-values.ts: slot tombstones + element tombstones) and carry their
 * stable element id. Binding conflicts resolve per the SCHEMA.md diamond rule
 * (PG4): OWN bindings first (first-class-applied-wins — the class
 * whose OR-Set membership add carries the earliest HLC, exact ties by class
 * id), then INHERITED bindings by shortest extends-path (BFS over
 * class_extends; the class itself is distance 0), ties by the same assignment
 * order — and only ACTIVE rows are candidates (PC4: an inactive binding stops
 * contributing metadata while authored values survive, read as
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
  /** The schema's icon (owner 2026-10-20); null = none. */
  icon: string | null;
  /** The SOLE locality authority (owner ruling 2026-10-20, R1): the scope
   *  class list (null = global). Eligibility walks the node's class closure
   *  against this list — extends-aware, the binding-resolution closure. */
  scopeClassIds: string[] | null;
  /** Value validation rules (owner 2026-10-20); null = none. */
  validationRules: { min?: number; max?: number; pattern?: string } | null;
  /** SCHEMA.md "Dates": finest granularity a date value may claim (NULL = day). */
  datePrecision: "year" | "month" | "day" | null;
  /** SCHEMA.md "Dates": node-typed values may carry date qualifiers. */
  dateQualified: boolean | null;
  /** SCHEMA.md "Number formats": display-only formatting (NULL = unformatted). */
  numberPad: number | null;
  numberDecimals: number | null;
  numberRounding: "round" | "floor" | "ceil" | "truncate" | null;
  /** PROPERTY-level render contracts (NULL = panel / unset). `readonly`
   *  retired 2026-10-21 — derived from the system list, not stored. */
  display: "panel" | "bullet" | "inline" | null;
  hideWhenEmpty: boolean | null;
}

/**
 * One effective (schema, idx) row for a node. `source` tags authored vs
 * derived vs empty declarations (assigned = the node's own pin, bound =
 * the class's virtual contribution); `boundBy` is the class supplying the
 * binding metadata — the winning class for a default or a bound-empty row,
 * the currently-binding class for an authored row, or null when no current
 * class binds the schema (an authored value whose binding went away stays
 * visible, marked unbound; an assigned row is unbound by construction —
 * the declaration is the node's own).
 */
export interface EffectiveProperty {
  propertySchemaId: string;
  idx: number;
  /** PG5: the value's stable element id (the property_value row id) — the
   *  address multi-value removes target. Assigned-empty rows carry a
   *  deterministic synthetic id (`assigned:<schema-id>`). */
  elementId: string;
  schema: EffectivePropertySchema | null;
  /** The authored/default value; NULL on an assigned-empty row (the
   *  assignment declares the property without a value — owner ruling
   *  2026-10-23). */
  value: unknown;
  /** Authored qualifiers (property.set metadata — PC6 date refs or legacy
   *  ISO strings on dateQualified schemas); null for derived defaults and
   *  assigned-empty rows. */
  metadata: Record<string, unknown> | null;
  source: "authored" | "default" | "assigned" | "bound";
  boundBy: string | null;
  /** PROPERTY-level: the schema's render contracts — the same for
   *  every carrier, class-bound or not. (Readonly-ness derives from the
   *  system property list since the owner ruling 2026-10-21 — the field
   *  left the wire and the store together.) */
  hideWhenEmpty: boolean | null;
  display: "panel" | "bullet" | "inline" | null;
  /**
   * R3 eligibility (owner ruling 2026-10-20): false when the schema's
   * scopeClassIds excludes the node (its class closure misses the list) —
   * the row survives (authored values always survive; narrowing a scope is
   * never retroactive) but callers know it is out of scope; derived defaults
   * never materialize for ineligible nodes (R4), so only authored rows can
   * carry eligible=false. Schema-less rows (schema deleted) read true.
   */
  eligible: boolean;
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

/** A stored JSON array column as a string array (NULL/malformed → null). */
function parseJsonArray(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
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

  // 1b. Node-level ASSIGNMENT rows (owner ruling 2026-10-23 — the v1
  //     `node_property` lineage): the (node, property) pair declarations.
  //     An assigned schema with no authored rows and no derived default
  //     synthesizes an empty row in step 5b.
  const assignedRows = db
    .prepare("SELECT property_schema_id FROM node_property WHERE node_id = ?")
    .all(nodeId) as Array<{ property_schema_id: string }>;

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
    `SELECT property_schema_id
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
    ...assignedRows.map((r) => r.property_schema_id),
  ]);
  const schemas = new Map<string, EffectivePropertySchema>();
  /** The schema's stored default (parsed JSON; undefined = no default). */
  const schemaDefault = new Map<string, unknown>();
  if (schemaIds.size > 0) {
    const placeholders = [...schemaIds].map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, name, type, multi, icon, scope_class_ids, validation_rules,
                date_precision, date_qualified,
                number_pad, number_decimals, number_rounding,
                display, hide_when_empty, default_value
         FROM property_schema WHERE id IN (${placeholders})`,
      )
      .all(...schemaIds) as Array<{
      id: string;
      name: string;
      type: string;
      multi: number;
      icon: string | null;
      scope_class_ids: string | null;
      validation_rules: string | null;
      date_precision: string | null;
      date_qualified: number | null;
      number_pad: number | null;
      number_decimals: number | null;
      number_rounding: string | null;
      display: string | null;
      hide_when_empty: number | null;
      default_value: string | null;
    }>;
    for (const row of rows) {
      if (row.default_value !== null) schemaDefault.set(row.id, parseJson(row.default_value));
      schemas.set(row.id, {
        id: row.id,
        name: row.name,
        type: row.type,
        multi: row.multi === 1,
        icon: row.icon,
        scopeClassIds: parseJsonArray(row.scope_class_ids),
        validationRules: (() => {
          const parsed = row.validation_rules === null ? null : parseJson(row.validation_rules);
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as { min?: number; max?: number; pattern?: string })
            : null;
        })(),
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
        hideWhenEmpty: flag(row.hide_when_empty),
      });
    }
  }

  // 4b. R3 eligibility (owner ruling 2026-10-20): the node's EXTENDS-AWARE
  //     class closure (its classes + all ancestors via reachOf — the same
  //     walk binding resolution uses) against each schema's scopeClassIds.
  //     A schema is eligible for the node when global (null list) or the
  //     closure intersects the list. The closure set is computed once.
  const nodeClassClosure = new Set<string>();
  for (const cls of classes) {
    for (const reach of reachOf(cls.class_id)) nodeClassClosure.add(reach.ancestorId);
  }
  const eligibleBySchema = new Map<string, boolean>();
  for (const [schemaId, schema] of schemas) {
    const scope = schema.scopeClassIds;
    eligibleBySchema.set(
      schemaId,
      scope === null || scope.some((id) => nodeClassClosure.has(id)),
    );
  }
  const eligibleOf = (schemaId: string, schema: EffectivePropertySchema | null): boolean =>
    schema === null ? true : (eligibleBySchema.get(schemaId) ?? true);

  // 5. Merge: authored wins per (schema, idx, ELEMENT — PG5: rows at the same
  //    idx are distinct elements and all surface); a winning ACTIVE binding
  //    (PC4 — inactive rows never became candidates) with a default and NO
  //    authored value at idx 0 derives a default row.
  const rows = new Map<string, EffectiveProperty>();
  const schemasWithRows = new Set<string>();
  const push = (key: string, row: EffectiveProperty): void => {
    rows.set(key, row);
    schemasWithRows.add(row.propertySchemaId);
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
      // Readonly/hideWhenEmpty/display are per-PROPERTY (the schema — unbound
      // values included, the owner's multi-class/unbound cases).
      hideWhenEmpty: schema?.hideWhenEmpty ?? null,
      display: schema?.display ?? null,
      // Authored rows SURVIVE scope narrowing (never retroactive) — the
      // read tags them; callers decide how an ineligible row renders.
      eligible: eligibleOf(authored.property_schema_id, schema),
    });
  }

  for (const [schemaId, winner] of winnerBySchema) {
    const { classId } = winner;
    // The default VALUE is schema-level (owner ruling 2026-10-20): the
    // winning binding decides the property is present (and supplies
    // boundBy), the schema row supplies the value.
    if (!schemaDefault.has(schemaId)) continue; // schema without a default
    const defaultValue = schemaDefault.get(schemaId);
    // R4 (owner ruling 2026-10-20): an ineligible node shows NEITHER the
    // property NOR a derived default from an out-of-scope binding — a stray
    // binding must not render a value for a property the node can't have.
    const schemaForEligibility = schemas.get(schemaId) ?? null;
    if (!eligibleOf(schemaId, schemaForEligibility)) continue;
    // PC2 read-side: a stored default that no longer matches the schema
    // type (written before validation, or after a delete+recreate changed
    // the type) yields no default rather than a wrong-typed value.
    const schema = schemaForEligibility;
    if (schema && !isValidDefaultForType(schema.type, defaultValue)) continue;
    if (shadowedDefaultSchemas.has(schemaId)) continue; // authored at idx 0 shadows the default
    push(`${schemaId}:0:default`, {
      propertySchemaId: schemaId,
      idx: 0,
      elementId: `default:${schemaId}:0`,
      schema: schema ?? null,
      value: defaultValue,
      metadata: null,
      source: "default",
      boundBy: classId,
      hideWhenEmpty: schema?.hideWhenEmpty ?? null,
      display: schema?.display ?? null,
      eligible: true,
    });
  }

  // 5b. Node-level ASSIGNMENT (owner ruling 2026-10-23 — the v1
  //     `node_property` lineage): an assigned schema with NO rows at all
  //     (neither authored nor a derived default) synthesizes an EMPTY row —
  //     the panel renders it and the row's own editor authors the first
  //     value via an ordinary property.set. A schema-less assignment
  //     (schema deleted after the assign — enforcement is never
  //     retroactive) renders nothing; hideWhenEmpty schemas stay hidden
  //     (the render contract is property-level).
  for (const assignment of assignedRows) {
    const schemaId = assignment.property_schema_id;
    if (schemasWithRows.has(schemaId)) continue;
    const schema = schemas.get(schemaId) ?? null;
    if (schema === null) continue;
    if (schema.hideWhenEmpty === true) continue;
    push(`assigned:${schemaId}`, {
      propertySchemaId: schemaId,
      idx: 0,
      elementId: `assigned:${schemaId}`,
      schema,
      value: null,
      metadata: null,
      source: "assigned",
      boundBy: null,
      hideWhenEmpty: schema.hideWhenEmpty,
      display: schema.display,
      eligible: eligibleOf(schemaId, schema),
    });
  }

  // 5c. BOUND-but-empty (owner ruling 2026-10-23, the virtual/realized
  //     assessment): a winning ACTIVE binding with NO rows at all (no
  //     authored value, no derived default, no assignment) synthesizes an
  //     EMPTY row — the VIRTUAL property shows as coming from the class
  //     (boundBy names the binder) until realized (property.assign) or
  //     valued. Scalar types included: the panel's bound-empty pass used
  //     to cover grouped types only, leaving url/email/number bindings
  //     invisible — the effective read is the single authority for what a
  //     node carries. Same gates as the assigned row: schema deleted →
  //     nothing renders; hideWhenEmpty stays hidden; an ineligible node
  //     (R4, scope narrowed after the bind) shows neither the row nor a
  //     default. Assigned rows (5b) win the slot — the declaration is the
  //     node's own.
  for (const [schemaId, winner] of winnerBySchema) {
    if (schemasWithRows.has(schemaId)) continue;
    const schema = schemas.get(schemaId) ?? null;
    if (schema === null) continue;
    if (schema.hideWhenEmpty === true) continue;
    if (!eligibleOf(schemaId, schema)) continue;
    push(`bound:${schemaId}`, {
      propertySchemaId: schemaId,
      idx: 0,
      elementId: `bound:${schemaId}`,
      schema,
      value: null,
      metadata: null,
      source: "bound",
      boundBy: winner.classId,
      hideWhenEmpty: schema.hideWhenEmpty,
      display: schema.display,
      eligible: true,
    });
  }

  // 6. Deterministic presentation order: PURE ALPHABETICAL by property
  //    name (owner ruling 2026-10-21 — binding `sequence` retired; class
  //    panels have no configurable order), UNBOUND AUTHORED rows last
  //    (assigned-empty rows join the main block — the declaration is the
  //    node's own, not an orphan), (idx, element id) as the tiebreak (PG5:
  //    concurrent adds may share an idx — the element id orders them
  //    identically on every replica).
  const nameOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;
  const unboundAuthoredLast = (row: EffectiveProperty): boolean =>
    row.boundBy === null && row.source === "authored";
  return [...rows.values()].sort((a, b) => {
    const boundDelta = (unboundAuthoredLast(a) ? 1 : 0) - (unboundAuthoredLast(b) ? 1 : 0);
    if (boundDelta !== 0) return boundDelta;
    const nameDelta = nameOf(a).localeCompare(nameOf(b));
    if (nameDelta !== 0) return nameDelta;
    const idxDelta = a.idx - b.idx;
    if (idxDelta !== 0) return idxDelta;
    return a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0;
  });
}
