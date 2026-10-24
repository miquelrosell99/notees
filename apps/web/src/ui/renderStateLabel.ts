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

/** The minimal node facts the label needs (ClientNode satisfies it). The
 *  classIds ride the parentlessRole "block" demote (owner 2026-10-24); absent
 *  = the pre-flag label behavior. */
export type RenderStateLabelInput = {
  isClass: boolean;
  isEmbedded: boolean;
  parentId: string | null;
  classIds?: string[];
};

/** Render-state label: "Class" | "Page" | "Block". The optional resolver
 *  carries the parentlessRole "block" demote (owner 2026-10-24); without it
 *  a parentless flagged-class node keeps the pre-flag "Page" label. */
export function renderStateLabel(
  node: RenderStateLabelInput,
  isParentlessBlockClass?: (classId: string) => boolean,
): string {
  if (isClassNode(node)) return "Class";
  return rendersWithDocumentChrome(node, undefined, isParentlessBlockClass) ? "Page" : "Block";
}

/** Human "Untitled page/class/block" fallback for empty display names. */
export function untitledLabelOf(
  node: RenderStateLabelInput,
  isParentlessBlockClass?: (classId: string) => boolean,
): string {
  return `Untitled ${renderStateLabel(node, isParentlessBlockClass).toLowerCase()}`;
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

/** The client shape the parentlessRole resolver needs (WorkspaceClient and
 *  WorkerClient both satisfy it — the extends-aware chain walk). */
export type ParentlessBlockResolverClient = {
  effectiveClassParentlessBlock(classId: string): boolean;
};

/** The resolver argument for the domain role predicates' parentless branch
 * (owner 2026-10-24): binds the extends-aware "block" demote to a client.
 * Pass it at EVERY rendersWithDocumentChrome / rendersAsInlineBlock call
 * site — a parentless flagged-class node renders Block-role, and a missing
 * resolver silently keeps the pre-flag page behavior. */
export function parentlessBlockResolverOf(
  client: ParentlessBlockResolverClient,
): (classId: string) => boolean {
  return (classId) => client.effectiveClassParentlessBlock(classId);
}
