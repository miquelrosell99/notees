/**
 * Plaintext extraction for the FTS index (v1 `derived/search.py` port,
 * extended per SCHEMA.md's owed FTS spec): text runs, typed-link text,
 * mention captured text, math expressions and recursive quote children come
 * from the domain excerpt helper; asset original names are joined from
 * node_asset; text-ish property values (§34.30 M5) are appended from
 * property_value — a carrier block's content for node-backed text, scalar
 * strings as-is, select option labels, numbers in string form. Plaintext is
 * derived by the applier, never stored as truth.
 */

import { plainTextExcerpt } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import { nodeRefOfValue, visiblePropertyValueRows } from "./property-values.js";
import type { StoreDatabase } from "./types.js";

export function parseContentAst(raw: string | null | undefined): ContentAst {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ContentAst) : [];
  } catch {
    return [];
  }
}

/** Content-derived plaintext: the excerpt plus asset names + quote children. */
function contentPlaintext(db: StoreDatabase, raw: string | null | undefined): string {
  const ast = parseContentAst(raw);
  const parts: string[] = [plainTextExcerpt(ast)];

  const lookup = db.prepare(
    "SELECT original_name FROM node_asset WHERE asset_id = ? ORDER BY node_id LIMIT 1",
  );
  const seenAssets = new Set<string>();
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as { type?: unknown; assetId?: unknown; children?: unknown };
      if (t.type === "asset_ref" && typeof t.assetId === "string" && !seenAssets.has(t.assetId)) {
        seenAssets.add(t.assetId);
        const row = lookup.get(t.assetId) as { original_name: string } | undefined;
        if (row && row.original_name) parts.push(row.original_name);
      } else if (t.type === "quote" && Array.isArray(t.children)) {
        walk(t.children);
      }
    }
  };
  walk(ast);

  return parts.filter((p) => p.length > 0).join(" ");
}

/** Schema types whose values contribute searchable text (§34.30 M5). */
const SEARCH_INDEXED_VALUE_TYPES = new Set([
  "text",
  "url",
  "email",
  "select",
  "multi_select",
  "number",
]);

/**
 * Text-ish property values of a node, one level deep: a text carrier's own
 * content plaintext (the carrier's children index as their own nodes), a
 * scalar string as-is, select labels resolved from the schema options, a
 * number in string form. Date refs, object refs, booleans and ranges are
 * structural — they stay out of the FTS row.
 */
function propertyValuesPlaintext(db: StoreDatabase, nodeId: string): string {
  // PG5: only the VISIBLE set indexes (a tombstoned element's text leaves the
  // row with its element).
  const rows = visiblePropertyValueRows(db, nodeId)
    .map((row) => {
      const schema = db
        .prepare("SELECT type, options FROM property_schema WHERE id = ?")
        .get(row.property_schema_id) as { type: string; options: string } | undefined;
      return schema === undefined
        ? null
        : { value: row.value, type: schema.type, options: schema.options };
    })
    .filter((row): row is { value: string; type: string; options: string } => row !== null);
  const carrierContent = db.prepare("SELECT content FROM node WHERE id = ?");
  const parts: string[] = [];
  for (const row of rows) {
    if (!SEARCH_INDEXED_VALUE_TYPES.has(row.type)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (parsed === null || parsed === undefined) continue;
    if (row.type === "text") {
      const ref = nodeRefOfValue(parsed);
      if (ref !== null) {
        // Node-backed: index the carrier's content (one level — the
        // carrier's own property values do not ride along).
        const carrier = carrierContent.get(ref) as { content: string } | undefined;
        const text = carrier ? contentPlaintext(db, carrier.content) : "";
        if (text) parts.push(text);
      } else if (typeof parsed === "string" && parsed.length > 0) {
        parts.push(parsed);
      }
    } else if (row.type === "url" || row.type === "email") {
      if (typeof parsed === "string" && parsed.length > 0) parts.push(parsed);
    } else if (row.type === "number") {
      if (typeof parsed === "number" && Number.isFinite(parsed)) parts.push(String(parsed));
    } else {
      // select / multi_select: the value is an option id — index the label.
      const ids = Array.isArray(parsed) ? parsed : [parsed];
      let labels: Array<{ id: string; label: string }> = [];
      try {
        labels = JSON.parse(row.options) as Array<{ id: string; label: string }>;
      } catch {
        labels = [];
      }
      for (const id of ids) {
        if (typeof id !== "string") continue;
        const option = labels.find((o) => o.id === id);
        if (option && option.label) parts.push(option.label);
        else parts.push(id);
      }
    }
  }
  return parts.join(" ");
}

/**
 * Derived search plaintext for one node's serialized contentAst. `nodeId`
 * (optional, additive) also folds the node's text-ish property values into
 * the row — reindexAllSearch rebuilds every row from the same function.
 */
export function extractSearchPlaintext(
  db: StoreDatabase,
  raw: string | null | undefined,
  nodeId?: string,
): string {
  const parts = [contentPlaintext(db, raw)];
  if (nodeId !== undefined) parts.push(propertyValuesPlaintext(db, nodeId));
  return parts
    .filter((p) => p.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
