/**
 * Store-row → client-shape mappers: the node-row projection (mapNode), its
 * per-row identity stamp (the nodeMapCache soundness contract), and the two
 * small column parsers. Pure functions over rows — no client state.
 */

import type { ContentAst, ListStyle } from "@notees/protocol";
import type { NodeRow } from "@notees/store";

import type { ClientNode } from "./types.js";

/** Parse a node row's serialized content (mirror of the store's parser). */
export function parseContentAst(raw: string | null | undefined): ContentAst {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ContentAst) : [];
  } catch {
    return [];
  }
}

/** The stored column is TEXT; only the wire enum values map through
 * (cross-version snapshots can predate the column or carry drift). */
export function parseListStyle(raw: string | null | undefined): ListStyle | null {
  return raw === "numbered" || raw === "alpha" || raw === "roman" ? raw : null;
}

/** The class-level parentlessRole column (store v32): "block" renders the
 * class's parentless members Block-role; anything else (NULL, drift) is the
 * "page" default. */
export function parseParentlessRole(raw: string | null | undefined): "page" | "block" {
  return raw === "block" ? "block" : "page";
}

export function mapNode(row: NodeRow): ClientNode {
  // Each column parses independently: a missing/legacy column must never
  // wipe the other (cross-version snapshots can predate a column).
  let classIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.class_ids);
    if (Array.isArray(parsed)) classIds = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    classIds = [];
  }
  let tagIds: string[] = [];
  try {
    const parsedTags: unknown = JSON.parse(row.tag_ids ?? "[]");
    if (Array.isArray(parsedTags)) {
      tagIds = parsedTags.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    tagIds = [];
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    isClass: row.is_class === 1,
    isEmbedded: row.is_embedded === 1,
    parentId: row.parent_id,
    classIds,
    tagIds,
    name: row.name,
    contentAst: parseContentAst(row.content),
    icon: row.icon,
    color: row.color,
    coverAssetId: row.cover_asset_id ?? null,
    bannerAssetId: row.banner_asset_id ?? null,
    aliasedNodeId: row.aliased_node_id ?? null,
    description: row.description ?? null,
    listStyle: parseListStyle(row.list_style),
    parentlessRole: parseParentlessRole(row.parentless_role),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Per-row identity stamp for the `mapNode` cache, hashing exactly
 * the raw columns `mapNode` consumes. Metadata stamps are UNSOUND here:
 * membership recomputes touch `class_ids`/`tag_ids` without bumping
 * `hlc`/`updated_at` (appliers.ts recomputeClassIds/recomputeTagIds), so the
 * stamp must cover the values themselves. Two FNV-1a-style 32-bit runs with
 * different constants give a ~64-bit space (per-row-version collision
 * ~2^-64); a matching pair means every mapped column is byte-identical.
 * Returns the pair instead of a combined Number — 2^64 exceeds the safe
 * integer range.
 */
export function nodeRowStamp(row: NodeRow): { h1: number; h2: number } {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000197;
  const mix = (value: string | number | null): void => {
    const text = value === null ? "\x00" : String(value);
    for (let i = 0; i < text.length; i++) {
      h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193);
      h2 = Math.imul(h2 ^ (text.charCodeAt(i) + 0x9e37), 0x85ebca6b);
    }
    // Column-boundary + length folding (naive concat would alias ab|c / a|bc).
    h1 = Math.imul(h1 ^ (text.length + 0x1f), 0x01000193);
    h2 = Math.imul(h2 ^ (text.length + 0x1e), 0x85ebca6b);
  };
  mix(row.id);
  mix(row.workspace_id);
  mix(row.is_class);
  mix(row.is_embedded);
  mix(row.parent_id);
  mix(row.class_ids);
  mix(row.tag_ids);
  mix(row.name);
  mix(row.content);
  mix(row.icon);
  mix(row.color);
  mix(row.cover_asset_id);
  mix(row.banner_asset_id);
  mix(row.aliased_node_id);
  mix(row.description);
  mix(row.list_style);
  mix(row.parentless_role);
  mix(row.is_active);
  mix(row.created_at);
  mix(row.updated_at);
  return { h1: h1 >>> 0, h2: h2 >>> 0 };
}
