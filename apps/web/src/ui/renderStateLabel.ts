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
