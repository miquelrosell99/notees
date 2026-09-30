import type { ClientNode } from "@/core/workspace-client.js";

/**
 * nodeIcon — the effective icon for a node: its own icon wins; otherwise the
 * first class (in classIds order) that defines an icon. Pages get this in
 * headers/lists; blocks show it in place of the bullet dot. `classesById`
 * maps class id → icon (build once per tree/render from listClasses()).
 */
export function nodeIcon(
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
