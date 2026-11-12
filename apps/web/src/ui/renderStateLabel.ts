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

import {
  isClassNode,
  rendersAsInlineBlock,
  rendersWithDocumentChrome,
} from "@notees/domain";

/** The minimal node facts the label needs (ClientNode satisfies it). The
 *  classIds ride the parentlessRole "block" demote; absent
 *  = the pre-flag label behavior. */
export type RenderStateLabelInput = {
  isClass: boolean;
  isEmbedded: boolean;
  parentId: string | null;
  classIds?: string[];
};

/** Render-state label: "Class" | "Page" | "Block". The optional resolver
 *  carries the parentlessRole "block" demote; without it
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

/** Parent render facts for the parent-page condition: the parent's own render-state fields when the node is
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
 *: binds the extends-aware "block" demote to a client.
 * Pass it at EVERY rendersWithDocumentChrome / rendersAsInlineBlock call
 * site — a parentless flagged-class node renders Block-role, and a missing
 * resolver silently keeps the pre-flag page behavior. */
export function parentlessBlockResolverOf(
  client: ParentlessBlockResolverClient,
): (classId: string) => boolean {
  return (classId) => client.effectiveClassParentlessBlock(classId);
}

/** The minimal node facts the bound role predicates read — every field
 *  optional like the domain's NodeLike picks, so ClientNode rows AND the
 *  query-run summaries (isClass/isEmbedded/parentId only) both satisfy it. */
export type RoleFacts = {
  id?: string;
  isClass?: boolean | number;
  isEmbedded?: boolean | number;
  parentId?: string | null;
  classIds?: string[];
};

/** The client shape the bound role predicates need (WorkspaceClient,
 *  WorkerClient, and the query-run bridge all satisfy it). */
export type RolePredicateClient = {
  getNode(id: string): RoleFacts | undefined;
  effectiveClassParentlessBlock(classId: string): boolean;
};

/** Parent facts for the bound predicates: the parent's own render-state
 *  fields when the node is parented, else undefined (see parentRenderFacts). */
function roleParentFacts(
  client: RolePredicateClient,
  node: { parentId?: string | null },
): RoleFacts | undefined {
  return node.parentId != null ? client.getNode(node.parentId) : undefined;
}

/** The bound Page-role predicate: rendersWithDocumentChrome with the parent
 *  facts and the extends-aware parentlessRole resolver both derived from the
 *  client — the call chain every surface otherwise copy-pastes. */
export function rendersWithDocumentChromeOf(client: RolePredicateClient, node: RoleFacts): boolean {
  return rendersWithDocumentChrome(node, roleParentFacts(client, node), parentlessBlockResolverOf(client));
}

/** The bound Block-role predicate: the rendersAsInlineBlock twin of
 *  rendersWithDocumentChromeOf. */
export function rendersAsInlineBlockOf(client: RolePredicateClient, node: RoleFacts): boolean {
  return rendersAsInlineBlock(node, roleParentFacts(client, node), parentlessBlockResolverOf(client));
}

/** The guard cap every containing-page climb shares (a cycle or a corrupt
 *  chain never loops forever). */
const ANCESTOR_WALK_GUARD = 64;

/**
 * The containing-page walk shared by every "resolve the block's page"
 * surface: the guard-capped parentId climb to the nearest ancestor rendering
 * with document chrome (the parent-page condition rides along — a bit under
 * a non-page parent is inert, so the walk continues past it). Starts at
 * `node.parentId`; pass `includeSelf` for walks that count the node itself
 * (the calendar group-by, the condensed-links popup). Undefined when the
 * chain breaks (a missing row) or no ancestor matches — each caller shapes
 * its own fallback.
 */
export function nearestDocumentChromeAncestor<T extends RoleFacts & { id: string }>(
  client: {
    getNode(id: string): T | undefined;
    effectiveClassParentlessBlock(classId: string): boolean;
  },
  node: { id?: string; parentId?: string | null },
  opts?: { includeSelf?: boolean },
): T | undefined {
  let currentId: string | undefined =
    opts?.includeSelf === true ? node.id : (node.parentId ?? undefined);
  for (let guard = 0; currentId !== undefined && guard < ANCESTOR_WALK_GUARD; guard += 1) {
    const current = client.getNode(currentId);
    if (current === undefined) return undefined;
    if (rendersWithDocumentChromeOf(client, current)) return current;
    currentId = current.parentId ?? undefined;
  }
  return undefined;
}
