/**
 * Logseq DB (.sqlite) kvs decoder — the transit-encoded datom store read into
 * a per-entity attribute map. The `kvs` table stores current-state datoms in
 * transit verbose JSON (`["^ ","~:keys",[[e,a,v,tx],…]]` pages; addr 0 is the
 * schema row, addr 1 the kv index — both ignored). Attribute keywords keep
 * their namespaced form (`:block/title`); UUIDs become plain strings.
 *
 * Merge rule: the store holds only current datoms (retractions are physical),
 * so every datom for an attribute is a current value — repeated attributes
 * collect into arrays (cardinality many). For well-known scalar attributes a
 * defensive max-tx-wins applies, so a store that does carry history still
 * yields the latest scalar.
 */

import transit from "transit-js";

export interface KvsRow {
  addr: number;
  content: string;
}

/** Attributes whose multiple datoms mean "updated", not "many values". */
const SCALAR_ATTRS = new Set([
  ":block/title",
  ":block/name",
  ":block/uuid",
  ":block/parent",
  ":block/page",
  ":block/order",
  ":block/journal-day",
  ":db/ident",
  ":logseq.property/type",
  ":db/cardinality",
]);

export type LqEntity = Record<string, unknown>;

/** Normalize decoded transit values: keywords → ":ns/name", UUIDs → strings,
 * maps/arrays → plain JS recursively (composite values like icons). */
function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (transit.isKeyword(value) || transit.isSymbol(value)) {
    return value.toString();
  }
  if (transit.isUUID(value)) return value.toString();
  if (transit.isMap(value)) {
    const out: Record<string, unknown> = {};
    (value as { forEach(fn: (v: unknown, k: unknown) => void): void }).forEach((v, k) => {
      out[JSON.stringify(normalizeValue(k))] = normalizeValue(v);
    });
    return out;
  }
  if (Array.isArray(value) || transit.isList(value) || transit.isSet?.(value)) {
    return [...(value as unknown[])].map(normalizeValue);
  }
  return String(value);
}

export function decodeKvs(rows: KvsRow[]): Map<number, LqEntity> {
  const reader = transit.reader("json-verbose");
  // eid → attr → { values, txs }
  const acc = new Map<number, Map<string, { values: unknown[]; txs: number[] }>>();

  for (const row of rows) {
    if (row.addr === 0 || row.addr === 1) continue;
    let page: unknown;
    try {
      page = reader.read(row.content);
    } catch {
      continue;
    }
    if (!page || typeof page !== "object" || !("get" in page) || typeof page.get !== "function") {
      continue;
    }
    const keys = (page as { get: (k: unknown) => unknown }).get(transit.keyword("keys"));
    if (!keys) continue;
    for (const datom of keys as unknown[]) {
      const [e, a, v, tx] = datom as [number, unknown, unknown, number];
      if (typeof e !== "number") continue;
      const attr = a && typeof (a as { toString?: () => string }).toString === "function"
        ? (a as { toString: () => string }).toString()
        : String(a);
      let ent = acc.get(e);
      if (!ent) {
        ent = new Map();
        acc.set(e, ent);
      }
      let slot = ent.get(attr);
      if (!slot) {
        slot = { values: [], txs: [] };
        ent.set(attr, slot);
      }
      slot.values.push(normalizeValue(v));
      slot.txs.push(typeof tx === "number" ? tx : 0);
    }
  }

  const entities = new Map<number, LqEntity>();
  for (const [eid, attrs] of acc) {
    const entity: LqEntity = {};
    for (const [attr, slot] of attrs) {
      let value: unknown = slot.values.length === 1 ? slot.values[0]! : slot.values;
      if (SCALAR_ATTRS.has(attr) && slot.values.length > 1) {
        let best = 0;
        for (let i = 1; i < slot.values.length; i++) {
          if ((slot.txs[i] ?? 0) >= (slot.txs[best] ?? 0)) best = i;
        }
        value = slot.values[best]!;
      }
      entity[attr] = value;
    }
    entities.set(eid, entity);
  }
  return entities;
}

/** All values of an attribute as an array (single values become one-element arrays). */
export function attrValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}
