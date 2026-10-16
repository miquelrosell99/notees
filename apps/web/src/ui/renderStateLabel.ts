/**
 * renderStateLabel — the one shared render-state type label (Revision 11).
 *
 * The retired node-kind enumeration is replaced by two booleans, and the
 * Page/Block/Class vocabulary survives as RENDER-STATE names only: a class
 * node is a "Class" everywhere; any other node renders as a "Page" when it
 * carries document chrome (parentless or a parent's main child) and as a
 * "Block" when it sits inline in a parent's body. Built on @notees/domain's
 * cascade helpers so every surface derives the label the same way.
 */

import { isClassNode, rendersWithDocumentChrome } from "@notees/domain";

/** The minimal node facts the label needs (ClientNode satisfies it). */
export type RenderStateLabelInput = {
  isClass: boolean;
  presentAsMain: boolean;
  parentId: string | null;
};

/** Render-state label: "Class" | "Page" | "Block". */
export function renderStateLabel(node: RenderStateLabelInput): string {
  if (isClassNode(node)) return "Class";
  return rendersWithDocumentChrome(node) ? "Page" : "Block";
}

/** Human "Untitled page/class/block" fallback for empty display names. */
export function untitledLabelOf(node: RenderStateLabelInput): string {
  return `Untitled ${renderStateLabel(node).toLowerCase()}`;
}

/** The minimal client shape the parent lookup needs (WorkspaceClient and
 *  WorkerClient both satisfy it). */
type ParentLookup = { getNode(id: string): RenderStateLabelInput | undefined };

/** Parent render facts for the parent-page condition (owner ruling
 *  2026-10-15): the parent's own render-state fields when the node is
 *  parented and the row is at hand, else undefined — parentless, or the
 *  parent row is not loaded. The store enforces the parent-page invariant
 *  write-time, so a missing parent never changes the answer over stored
 *  data; passing the facts keeps render honest on not-yet-migrated rows. */
export function parentRenderFacts(
  client: ParentLookup,
  node: { parentId: string | null },
): RenderStateLabelInput | undefined {
  return node.parentId !== null ? client.getNode(node.parentId) : undefined;
}
