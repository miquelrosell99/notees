/**
 * Grouping helpers — the groupBy capability's container side. Containers
 * own the grouping semantics (they know what the key MEANS); the views only
 * render the resolved CollectionGroup structure.
 */

import type { AnyClient, CollectionGroup, NodeCollectionItem } from "./types.js";
import { displayNameFromClient, plainTitleOf } from "../../ui/dateDisplay.js";

/**
 * The resolved containing-page grouping (groupByContainingPage): the
 * collapsible page groups PLUS the page sources — items whose referencing
 * node IS the containing page (a page mentioning the target from its own
 * body). A page source never joins a group: it would be a self-named
 * one-row group, so it renders as its own top-level row, before the
 * groups (the view's `ungroupedItems` prop).
 */
export interface ContainingPageGrouping {
  standalone: NodeCollectionItem[];
  groups: CollectionGroup[];
}

/**
 * The references grouping: items group by
 * their containing page (`meta.containingPageId` — the breadcrumb of the
 * page the referencing node lives on); items without that meta group by
 * their own id; items whose source IS the containing page return in
 * `standalone` instead of a self-named group. Header click opens the page.
 * First-seen key order is kept.
 */
export function groupByContainingPage(
  client: AnyClient,
  items: NodeCollectionItem[],
  onOpenPage?: ((pageId: string) => void) | undefined,
): ContainingPageGrouping {
  const standalone: NodeCollectionItem[] = [];
  const byKey = new Map<string, NodeCollectionItem[]>();
  for (const item of items) {
    const metaPage = item.meta?.containingPageId;
    // A page referencing the target from its own body: the containing page
    // IS the source, so a group would name the row's own page after itself
    // — the row stands alone at the top level instead.
    if (typeof metaPage === "string" && metaPage === item.node.id) {
      standalone.push(item);
      continue;
    }
    const key = typeof metaPage === "string" ? metaPage : item.node.id;
    const group = byKey.get(key);
    if (group !== undefined) group.push(item);
    else byKey.set(key, [item]);
  }
  const groups = [...byKey.entries()].map(([key, groupItems]) => {
    const keyNode = client.getNode(key);
    return {
      id: key,
      // plainTitleOf, not displayNameFromClient: the header is flattened
      // chrome, so a markdown link span in the page title renders as its
      // label text — never the raw `[label](href)` source.
      label:
        keyNode !== undefined
          ? plainTitleOf(keyNode, (classId) => displayNameFromClient(client, classId))
          : (displayNameFromClient(client, key) ?? "Untitled"),
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
  return { standalone, groups };
}
