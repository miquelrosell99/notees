/**
 * Grouping helpers — the groupBy capability's container side. Containers
 * own the grouping semantics (they know what the key MEANS); the views only
 * render the resolved CollectionGroup structure.
 */

import type { AnyClient, CollectionGroup, NodeCollectionItem } from "./types.js";
import { displayNameFromClient } from "../dateDisplay.js";

/**
 * The references grouping: items group by
 * their containing page (`meta.containingPageId` — the breadcrumb of the
 * page the referencing node lives on); items without that meta group by
 * their own id. Header click opens the page. First-seen key order is kept.
 */
export function groupByContainingPage(
  client: AnyClient,
  items: NodeCollectionItem[],
  onOpenPage?: ((pageId: string) => void) | undefined,
): CollectionGroup[] {
  const byKey = new Map<string, NodeCollectionItem[]>();
  for (const item of items) {
    const metaPage = item.meta?.containingPageId;
    const key = typeof metaPage === "string" ? metaPage : item.node.id;
    const group = byKey.get(key);
    if (group !== undefined) group.push(item);
    else byKey.set(key, [item]);
  }
  return [...byKey.entries()].map(([key, groupItems]) => {
    const keyNode = client.getNode(key);
    return {
      id: key,
      label: displayNameFromClient(client, key) ?? "Untitled",
      // The header icon is the key node's EFFECTIVE icon — own icon, else the
      // class-chain icon (a daily page shows its authored/class glyph, not a
      // hard-coded page default). effectiveNodeIcon never misses a live page
      // (its tail is the render-state default); the literal fallback covers
      // only a missing key node, and null (an iconless inline-block group)
      // coerces to undefined = no icon, per CollectionGroup.
      icon:
        keyNode !== undefined
          ? (client.effectiveNodeIcon(keyNode) ?? undefined)
          : "mdi-file-document-outline",
      onHeaderClick: onOpenPage === undefined ? undefined : () => onOpenPage(key),
      items: groupItems,
    };
  });
}
