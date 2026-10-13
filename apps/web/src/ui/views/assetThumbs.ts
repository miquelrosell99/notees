/**
 * Card imagery: image thumbnails for asset-classed nodes (the asset's own
 * bytes) and cover images (the `coverAssetId` wire node field → asset node).
 * Bytes are fetched once per asset node and cached for the session as data
 * URLs; failures resolve null and the card renders text-only.
 *
 * The cache is BOUNDED (lazy loading only fetches what the viewport
 * reaches, but long card sessions still accumulate) — past the cap the
 * oldest entries evict; an <img> already holding its data URL is unaffected
 * (the DOM string survives eviction; a re-mount just refetches).
 */

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client.js";

const cache = new Map<string, Promise<string | null>>();
/** Session-cache bound (entries). */
const CACHE_CAP = 250;

/** The image data URL for an asset node (cached per asset, LRU-bounded). */
export function assetImageUrl(
  client: { getAssetDataUrl(assetNodeId: string): Promise<string | null> },
  assetNodeId: string,
): Promise<string | null> {
  let pending = cache.get(assetNodeId);
  if (pending === undefined) {
    pending = client.getAssetDataUrl(assetNodeId);
    if (cache.size >= CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(assetNodeId, pending);
  } else {
    // Refresh recency: re-insert so the LRU order reflects the last use.
    cache.delete(assetNodeId);
    cache.set(assetNodeId, pending);
  }
  return pending;
}

/**
 * The asset node a card should show imagery for: the node itself when it is
 * classed `asset`, else the node's `coverAssetId` wire node field (the
 * coverProperty seam — the retired image-typed `cover` property is
 * superseded; the node column is the one read, so a cover set by ANY
 * client shows on the card). Null = the empty cover slot.
 */
export function cardImageAssetId(node: ClientNode): string | null {
  if (node.classIds.includes(SYSTEM_CLASS_UUIDS.asset)) return node.id;
  return node.coverAssetId ?? null;
}
