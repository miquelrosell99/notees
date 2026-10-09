import { defaultIconFor } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client.js";

/**
 * nodeIcon — the effective icon for a node: its own icon wins; otherwise the
 * first class (in classIds order) that defines an icon. When nothing is
 * authored anywhere, the render-state display default applies (class →
 * DEFAULT_CLASS_ICON, document chrome → DEFAULT_PAGE_ICON, inline block →
 * null — a block's chrome stays the bullet dot). Display-time only: the
 * stored icon stays empty until the user picks one. Pages get this in
 * headers/lists; blocks show it in place of the bullet dot. `classesById`
 * maps class id → icon (build once per tree/render from listClasses()).
 */
export function nodeIcon(
  node: Pick<ClientNode, "icon" | "classIds" | "isClass" | "presentAsMain" | "parentId">,
  classesById: ReadonlyMap<string, string | null>,
): string | null {
  if (node.icon !== null && node.icon !== "") return node.icon;
  for (const classId of node.classIds) {
    const icon = classesById.get(classId);
    if (icon !== null && icon !== undefined && icon !== "") return icon;
  }
  return defaultIconFor(node);
}

/**
 * definedNodeIcon — the icon a node carries BY DEFINITION: its own icon, else
 * the first class (in classIds order, the extends-resolved lookup) that
 * defines one. NO display-default fallback: the page header hides the icon
 * element entirely when nothing is defined (the Capacities precedent — the
 * "Add icon" action row button is the affordance instead), while
 * lists/mentions keep the generic default via `nodeIcon`.
 */
export function definedNodeIcon(
  node: Pick<ClientNode, "icon" | "classIds">,
  classesById: ReadonlyMap<string, string | null>,
): string | null {
  if (node.icon !== null && node.icon !== "") return node.icon;
  for (const classId of node.classIds) {
    const icon = classesById.get(classId);
    if (icon !== null && icon !== undefined && icon !== "") return icon;
  }
  return null;
}

/** Build the class-id → icon lookup once per render surface. */
export function classIconMap(
  classes: ReadonlyArray<Pick<ClientNode, "id" | "icon">>,
): Map<string, string | null> {
  return new Map(classes.map((cls) => [cls.id, cls.icon]));
}
