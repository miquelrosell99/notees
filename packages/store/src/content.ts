/**
 * Plaintext extraction for the FTS index (port of `derived/search.py`,
 * extended per SCHEMA.md's owed FTS spec): text runs, typed-link text,
 * math expressions and recursive quote children come from the domain
 * excerpt helper; a mention contributes its customLabel or its TARGET's
 * current display name (resolved here from the derived node row —
 * cascading through link-bearing titles with a path guard, so a
 * block→block→page chain resolves the page name at every level and a
 * mention cycle folds to nothing at the loop point, SCHEMA.md FTS spec
 * 2026-10-27); asset original names are joined
 * from node_asset; text-ish property values are appended from
 * property_value — a carrier block's content for node-backed text, scalar
 * strings as-is, select option labels, numbers in string form. Plaintext is
 * derived by the applier, never stored as truth.
 */

import { deriveDisplayName, plainTextExcerpt } from "@notees/domain";
import type { ContentAst } from "@notees/protocol";

import { nodeRefOfValue, visiblePropertyValueRows } from "./property-values.js";
import type { SqliteStatement, StoreDatabase } from "./types.js";

export function parseContentAst(raw: string | null | undefined): ContentAst {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ContentAst) : [];
  } catch {
    return [];
  }
}

/** Asset-name lookup, prepared once per connection (WeakMap: restore swaps
 *  the connection). */
const assetLookupStmtCache = new WeakMap<object, SqliteStatement>();

/** Mention-target content lookup, prepared once per connection (same
 *  restore-swap contract as the asset cache). */
const mentionTargetStmtCache = new WeakMap<object, SqliteStatement>();

/** Content-derived plaintext: the excerpt plus asset names + quote children. */
function contentPlaintext(db: StoreDatabase, raw: string | null | undefined): string {
  const ast = parseContentAst(raw);
  // A bare mention indexes its target's CURRENT display name (the no-stored-
  // link-text ruling): resolved from the derived node row at index time,
  // CASCADING through link-bearing titles (block→block→page chains resolve
  // the page name at every level) with a PATH guard — a diamond's second
  // mention still resolves; a true cycle folds to nothing at the loop
  // point. The FTS row is a projection: a rename heals on the target's next
  // content write or a reindexAllSearch pass (the v33 migration rides one).
  let mentionLookup = mentionTargetStmtCache.get(db);
  if (mentionLookup === undefined) {
    mentionLookup = db.prepare("SELECT content FROM node WHERE id = ?");
    mentionTargetStmtCache.set(db, mentionLookup);
  }
  const path = new Set<string>();
  const resolveMentionName = (targetId: string): string | null => {
    if (path.has(targetId)) return null; // mention cycle: fold, never hang
    const row = mentionLookup!.get(targetId) as { content: string } | undefined;
    if (row === undefined) return null;
    path.add(targetId);
    const name = deriveDisplayName(
      { id: targetId, contentAst: parseContentAst(row.content) },
      undefined,
      resolveMentionName,
    );
    path.delete(targetId);
    return name === "" ? null : name;
  };
  const parts: string[] = [plainTextExcerpt(ast, undefined, resolveMentionName)];

  // The asset-name lookup is prepared once per connection — the search
  // ranker calls this for every candidate row.
  let lookup = assetLookupStmtCache.get(db);
  if (lookup === undefined) {
    lookup = db.prepare(
      "SELECT original_name FROM node_asset WHERE asset_id = ? ORDER BY node_id LIMIT 1",
    );
    assetLookupStmtCache.set(db, lookup);
  }
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
      } else if (t.type === "heading" && Array.isArray(t.children)) {
        walk(t.children);
      }
    }
  };
  walk(ast);

  return parts.filter((p) => p.length > 0).join(" ");
}

/** Schema types whose values contribute searchable text. */
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
 * Content-derived plaintext ONLY (no property values) — the node's title
 * text under title-is-content. The search ranker matches literal queries
 * against this; the FTS row carries the property-value superset via
 * extractSearchPlaintext.
 */
export function extractContentPlaintext(
  db: StoreDatabase,
  raw: string | null | undefined,
): string {
  return contentPlaintext(db, raw);
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
