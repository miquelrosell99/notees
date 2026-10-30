/**
 * Property-row shells — the cheap bulk read for surfaces that enumerate MANY
 * nodes (every outline BlockRow, the calendar enumerations, the class
 * buckets/hubs) but provably touch only light property facts. Same rows as
 * the effective read (same identity/derivation fields, same ordering), but
 * `value` ships ONLY for LIGHT types; HEAVY types (and any unknown type —
 * the conservative default) defer the value and carry its cardinality in
 * `valueCount` instead. A deferred row's `value: null` never reads as
 * "empty" — `deferred` is the flag consumers branch on.
 *
 * The LIGHT set is derived from the wire vocabulary (packages/domain seeds:
 * text/number/boolean/datetime/email/select/multi_select/object/image/asset)
 * — select/multi_select/boolean/number/date/datetime values are small scalar
 * or option-id payloads; everything else (text bodies, urls, node refs,
 * unknown future types) is treated as HEAVY by default (membership test).
 *
 * The row assembly itself lives in effective.ts — one shared builder with a
 * value-mode flag, so the binding/derivation logic is never duplicated and
 * the full read stays byte-identical.
 */

import type { EffectiveProperty } from "./effective.js";

/**
 * The property types whose VALUES the shells read ships (identical to the
 * full read). Any type NOT in this set (text, email, object, asset, image,
 * url, unknown) is deferred: `value` reads null, `valueCount` carries the
 * cardinality, `deferred` is true.
 */
export const LIGHT_PROPERTY_VALUE_TYPES: ReadonlySet<string> = new Set([
  "select",
  "multi_select",
  "boolean",
  "number",
  "date",
  "datetime",
]);

/**
 * One effective (schema, idx) row in shell form: every field of
 * EffectiveProperty, plus the value-deferral contract. LIGHT-typed rows
 * carry the value verbatim (`deferred: false`); HEAVY-typed rows read
 * `value: null` with `deferred: true` — consumers must not treat that null
 * as "empty". Assigned/bound empty rows are never deferred (there is no
 * value to withhold): `valueCount: 0, deferred: false`.
 */
export interface PropertyRowShell extends EffectiveProperty {
  /** The number of values the row carries (0 on empty rows; 1 per authored
   *  element row; heavy rows report the count they withheld). */
  valueCount: number;
  /** True when a value EXISTS but was deferred (heavy type) — `value: null`
   *  on a deferred row is "withheld", not "empty". */
  deferred: boolean;
}
