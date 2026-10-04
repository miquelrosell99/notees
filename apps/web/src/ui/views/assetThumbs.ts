/**
 * Card imagery: image thumbnails for asset-classed nodes (the asset's own
 * bytes) and cover images (the node-typed `cover` property → asset node).
 * Bytes are fetched once per asset node and cached for the session as data
 * URLs; failures resolve null and the card renders text-only.
 *
 * §34.75: the cache is BOUNDED (lazy loading only fetches what the viewport
 * reaches, but long card sessions still accumulate) — past the cap the
 * oldest entries evict; an <img> already holding its data URL is unaffected
 * (the DOM string survives eviction; a re-mount just refetches).
 */

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { ClientNode, EffectiveProperty } from "@/core/workspace-client.js";

const cache = new Map<string, Promise<string | null>>();
/** §34.75: session-cache bound (entries). */
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
 * classed `asset`, else the `cover` property's target. Null = text-only card.
 */
export function cardImageAssetId(
  node: ClientNode,
  properties: EffectiveProperty[] | undefined,
): string | null {
  if (node.classIds.includes(SYSTEM_CLASS_UUIDS.asset)) return node.id;
  const cover = properties?.find((p) => p.propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover);
  const target = cover?.value as { nodeId?: unknown } | undefined;
  return typeof target?.nodeId === "string" ? target.nodeId : null;
}
