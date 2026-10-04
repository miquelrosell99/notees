/**
 * Property-value shapes — the one-shape-per-type invariant (SCHEMA.md
 * "Node-backed text properties" / "Dates"), enforced fail-loud at the
 * apply-time write path (PB2/PC2/PG6, §34.32) and re-checked defensively at
 * the effective read model (a stored value/default that no longer matches
 * the schema type yields nothing instead of garbage).
 *
 * Write shapes by schema type:
 *  - text: a scalar string (the seeded source family carries citekey/isbn/
 *    publisher as plain strings) OR a carrier-block reference
 *    `{ "nodeId": … }` (node-backed rich text). Archived data may hold the
 *    legacy bare-uuid carrier shape — reads stay lenient, writes go
 *    `{nodeId}`. Anything else (number/boolean/array/object-without-nodeId)
 *    is rejected: a text slot is string-or-reference.
 *  - date / object: a node reference `{ "nodeId": … }`; a bare-uuid string
 *    (legacy) is normalized to the reference shape, other strings are
 *    rejected (a scalar is not a node reference).
 *  - date_range: `{ "start": ref|null, "end": ref|null }` — either side
 *    open; each present side is a reference (legacy bare uuid normalized).
 *  - number: a finite number; a NUMERIC STRING is the v1-migrated legacy
 *    encoding (live data carries epoch-millis strings — verified against
 *    the owner's derived store 2026-10-04) and normalizes to a number,
 *    anything else is rejected.
 *  - boolean: a boolean. url / email / select: a string. multi_select: an
 *    array of strings (the option-id list).
 *  - image: UNCHECKED by design — the type has no defined value shape yet
 *    (§34.32 PG14's zombie row): live data carries v1 asset-payload records
 *    and legacy bare uuids, so any shape check would break replay of the
 *    migrated log. Validation arrives with PG14's owner call.
 *
 * Schema-linked integrity (PG6, asserted when the schema row exists —
 * unknown schema ids store unchecked, property.set has no schema FK):
 *  - cardinality: a single-value schema (multi = false) takes idx 0 only
 *    (asserted by the applier, which owns the payload's idx);
 *  - datePrecision: a date ref may not claim FINER granularity than the
 *    schema's ("year" < "month" < "day"; default day — SCHEMA.md "Dates");
 *  - targetClassFilter: a date/object ref's target must carry one of the
 *    filter classes (when the filter is declared);
 *  - target existence: a date/object/date_range ref must resolve to a node
 *    row (any liveness — trash is a state, not an absence). Text carrier
 *    refs are NOT existence-checked: PB2 keeps legacy carrier encodings
 *    read-lenient, and the migrated log carries sixteen of them.
 */

import { parseDateNodeId } from "@notees/domain";

import { PropertyValueShapeError } from "./errors.js";
import type { StoreDatabase } from "./types.js";

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for the legacy bare-uuid carrier encoding (archived data). */
export function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && UUID_LIKE.test(value);
}

/**
 * The node id a value references, when it is reference-shaped: either the
 * canonical `{ "nodeId": … }` or a legacy bare uuid. Scalar strings that
 * are not uuid-shaped return null (they are text, not references).
 */
export function nodeRefOfValue(value: unknown): string | null {
  if (typeof value === "object" && value !== null && "nodeId" in value) {
    const id = (value as { nodeId: unknown }).nodeId;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return isUuidLike(value) ? value : null;
}

/**
 * Validate a property.set value against the schema type; returns the value
 * to store (a legacy bare-uuid reference is normalized to `{nodeId}`).
 * `null` means "no value" and bypasses shape validation. Throws
 * PropertyValueShapeError on mismatch — fail-loud, per the register.
 */
export function assertValueShapeForType(type: string, value: unknown, opType: string): unknown {
  if (value === null) return value;
  switch (type) {
    case "text": {
      if (typeof value === "string") return value;
      const ref = nodeRefOfValue(value);
      if (ref !== null) return { nodeId: ref };
      break;
    }
    case "date":
    case "object": {
      const ref = nodeRefOfValue(value);
      if (ref !== null) return { nodeId: ref };
      break;
    }
    case "date_range": {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const range = value as { start?: unknown; end?: unknown };
        const side = (v: unknown): { nodeId: string } | null | undefined => {
          if (v === undefined) return undefined;
          if (v === null) return null;
          const ref = nodeRefOfValue(v);
          return ref !== null ? { nodeId: ref } : undefined;
        };
        const start = side(range.start);
        const end = side(range.end);
        if (start !== undefined && end !== undefined) return { start, end };
      }
      break;
    }
    default:
      return value;
  }
  throw new PropertyValueShapeError(
    `${opType}: value for ${type} schema must be ${
      type === "text"
        ? 'a string or a node reference { "nodeId": … }'
        : type === "date_range"
          ? '{ "start": ref|null, "end": ref|null } of node references'
          : 'a node reference { "nodeId": … }'
    } — got ${JSON.stringify(value)}`,
    opType,
  );
}

/**
 * PC2: a class-binding defaultValue must be typed per the schema type.
 * Node-typed schemas (date/date_range/object) accept only JSON null — a
 * default that links a node is meaningless ("arguably" per the register;
 * the citations family binds text/number/select defaults, never links).
 * `text` accepts scalar strings (the raw-text default editor's shape), not
 * carrier references. Returns false instead of throwing so the read model
 * can drop silently; the write path (class.property.set) fails loud.
 */
export function isValidDefaultForType(type: string, value: unknown): boolean {
  if (value === null) return true;
  switch (type) {
    case "text":
    case "url":
    case "email":
    case "image":
    case "select":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "multi_select":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "date":
    case "date_range":
    case "object":
      return false;
    default:
      return true;
  }
}

/** The schema row the value validators consult (PG6). */
export interface PropertySchemaValidationRow {
  id: string;
  type: string;
  multi: number;
  options: string;
  targetClassFilter: string | null;
  datePrecision: string | null;
}

/** Shape + scalar typing only (no graph checks) — the PG6 extension of
 *  assertValueShapeForType, keyed off the full schema row. Returns the
 *  normalized value to store. */
function assertScalarShapeForType(type: string, value: unknown, opType: string): unknown {
  if (value === null) return value;
  switch (type) {
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      // v1-migrated epoch-millis strings (live-data verified): normalize.
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return Number(value);
      }
      break;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
    case "url":
    case "email":
    case "select":
      if (typeof value === "string") return value;
      break;
    case "multi_select":
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
      break;
    default:
      // image and any future type: unchecked (see the file header).
      return value;
  }
  throw new PropertyValueShapeError(
    `${opType}: value for ${type} schema must be ${
      type === "number"
        ? "a finite number"
        : type === "boolean"
          ? "a boolean"
          : type === "multi_select"
            ? "an array of strings (option ids)"
            : "a string"
    } — got ${JSON.stringify(value)}`,
    opType,
  );
}

const DATE_PRECISION_RANK: Record<string, number> = { year: 1, month: 2, day: 3 };

/** Assert a node-typed ref's target honors the schema's graph constraints:
 *  row existence (any liveness) and the targetClassFilter, plus the date
 *  precision ceiling for date refs. */
function assertRefTargetForSchema(
  db: StoreDatabase,
  schema: PropertySchemaValidationRow,
  ref: string,
  opType: string,
): void {
  const target = db.prepare("SELECT class_ids FROM node WHERE id = ?").get(ref) as
    | { class_ids: string }
    | undefined;
  if (target === undefined) {
    throw new PropertyValueShapeError(
      `${opType}: value references node ${ref}, which does not exist`,
      opType,
    );
  }
  if (schema.targetClassFilter !== null) {
    let filter: unknown;
    try {
      filter = JSON.parse(schema.targetClassFilter);
    } catch {
      filter = null;
    }
    if (Array.isArray(filter) && filter.length > 0) {
      let classIds: unknown;
      try {
        classIds = JSON.parse(target.class_ids);
      } catch {
        classIds = [];
      }
      const carried = Array.isArray(classIds)
        ? classIds.filter((id): id is string => typeof id === "string")
        : [];
      // Extends-aware membership: the bibliography model filters authors by
      // `agent` while person/organization EXTEND agent (SCHEMA.md "Citations")
      // — a carried class satisfies the filter when it equals an entry or
      // descends from one through class_hierarchy.
      const allowed = new Set<string>(carried);
      if (carried.length > 0) {
        const ancestors = db
          .prepare(
            "SELECT ancestor_id FROM class_hierarchy WHERE class_id IN (SELECT value FROM json_each(?))",
          )
          .all(JSON.stringify(carried)) as Array<{ ancestor_id: string }>;
        for (const row of ancestors) allowed.add(row.ancestor_id);
      }
      if (!filter.some((classId) => typeof classId === "string" && allowed.has(classId))) {
        throw new PropertyValueShapeError(
          `${opType}: value target ${ref} does not carry any of the schema's allowed classes`,
          opType,
        );
      }
    }
  }
  if (schema.type === "date" || schema.type === "date_range") {
    const parsed = parseDateNodeId(ref);
    if (parsed !== null) {
      const ceiling = DATE_PRECISION_RANK[schema.datePrecision ?? "day"] ?? 3;
      if ((DATE_PRECISION_RANK[parsed.precision] ?? 3) > ceiling) {
        throw new PropertyValueShapeError(
          `${opType}: ${parsed.precision} date ref claims finer granularity than the schema's "${schema.datePrecision ?? "day"}" precision`,
          opType,
        );
      }
    }
  }
}

/**
 * PG6: the full apply-time validation for a property.set against a KNOWN
 * schema row — shape/scalar typing (assertValueShapeForType extended),
 * graph checks (existence / class filter / date precision) for the
 * node-typed link family. `null` means "no value" and bypasses everything.
 * Returns the normalized value to store.
 */
export function assertValueForSchema(
  db: StoreDatabase,
  schema: PropertySchemaValidationRow,
  value: unknown,
  opType: string,
): unknown {
  const shaped = assertValueShapeForType(schema.type, value, opType);
  const typed = assertScalarShapeForType(schema.type, shaped, opType);
  if (typed === null) return typed;
  if (schema.type === "date" || schema.type === "object") {
    const ref = nodeRefOfValue(typed);
    if (ref !== null) assertRefTargetForSchema(db, schema, ref, opType);
  } else if (schema.type === "date_range") {
    const range = typed as { start?: unknown; end?: unknown };
    for (const side of [range.start, range.end]) {
      const ref = nodeRefOfValue(side);
      if (ref !== null) assertRefTargetForSchema(db, schema, ref, opType);
    }
  }
  return typed;
}
