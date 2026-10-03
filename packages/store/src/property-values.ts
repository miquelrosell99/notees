/**
 * Property-value shapes — the one-shape-per-type invariant (SCHEMA.md
 * "Node-backed text properties" / "Dates"), enforced fail-loud at the
 * apply-time write path (PB2/PC2, §34.32) and re-checked defensively at
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
 *
 * Scalar types (number/boolean/url/email/select/multi_select/image) pass
 * through unchecked here — their validation rides the PG6 batch.
 */

import { PropertyValueShapeError } from "./errors.js";

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
