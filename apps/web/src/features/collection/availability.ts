/**
 * View availability — the collection-fed context behind the registry's
 * `availability` gating. `computeViewAvailability` derives the two arms from
 * the collection's own items + client (effective property values — a
 * date-typed property with ≥1 valued item counts; an item with ≥1 node-typed
 * value or mention counts as linked); `useAvailableViewModes` is the host
 * seam: run the surface's modes through it BEFORE the switcher and the
 * persisted-mode sanitize, so a gated mode neither renders nor rides the
 * switcher, and a persisted mode that gates out falls back to the surface
 * default (the viewPrefs sanitize ruling — a dead switch never resurrects).
 */

import { useMemo } from "react";

import { availableViewModes } from "./registry.js";
import type {
  AnyClient,
  NodeCollectionItem,
  ViewAvailabilityContext,
  ViewMode,
} from "./types.js";

/**
 * The collection-fed arms: `datePropertyCount` = distinct date-typed bound
 * properties carrying ≥1 value across the items; `linkedItemCount` = items
 * carrying ≥1 node-typed property value or content mention. Reads follow
 * the client's notify cycle — hosts re-run this on re-render like any
 * collection read.
 */
export function computeViewAvailability(
  client: AnyClient,
  items: readonly NodeCollectionItem[],
): ViewAvailabilityContext {
  const dateSchemas = new Set<string>();
  let linkedItemCount = 0;
  for (const item of items) {
    let linked = false;
    for (const property of client.getEffectiveProperties(item.node.id)) {
      const type = property.schema?.type;
      if (property.value === null || property.value === undefined) continue;
      if (type === "datetime") dateSchemas.add(property.propertySchemaId);
      if (type === "object") linked = true;
    }
    const ast = item.node.contentAst as ReadonlyArray<{ type?: unknown }>;
    if (Array.isArray(ast) && ast.some((token) => token?.type === "mention")) linked = true;
    if (linked) linkedItemCount += 1;
  }
  return { datePropertyCount: dateSchemas.size, linkedItemCount };
}

/**
 * The host seam: the surface's modes filtered through the registry's
 * availability gate against THIS collection's derived context. The result
 * feeds both the switcher and the persisted-mode sanitize's allowed list.
 */
export function useAvailableViewModes<M extends ViewMode | string>(
  client: AnyClient,
  items: readonly NodeCollectionItem[] | undefined,
  modes: readonly M[],
): M[] {
  return useMemo(
    () => availableViewModes(modes, computeViewAvailability(client, items ?? [])) as M[],
    // The effective-value reads follow the client's notify cycle; items
    // identity is the cheap proxy (hosts rebuild items per notify).
    [client, items, modes],
  );
}
