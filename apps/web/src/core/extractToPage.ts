/**
 * Block → page extraction — the "Convert to page ›" context-menu gesture
 * (owner 2026-10-16): an inline block leaves its parent and becomes a
 * root page, while a fresh link block takes its exact slot in the original
 * page — the link block's whole content is one `mention` of the extracted
 * node (identity preserved; rich content survives untouched, unlike the
 * presentAsMain promotion, which stringifies). The extracted node's
 * children either STAY in the original page (reparented onto the link
 * block, relative order preserved — the submenu's "children stay here"
 * row) or FOLLOW the extracted page (the "children follow" row — which
 * then is just the link-block replacement, children untouched).
 *
 * The gesture COMPOSES existing carriers — deliberately NO new op type:
 * one `object.create` (the link block, anchored at the source slot with
 * the m2 beforeId/afterId carriers) + `object.move` to the workspace root
 * + one `object.move` per reparented child (afterId chaining, the
 * merge-plan children precedent). Every client converges by replay with
 * zero applier changes; the wire stays untouched.
 *
 * Guards fail loud BEFORE anything reaches the log: the node must exist,
 * be an inline block (a page or class converts nothing), and not be a
 * date-chain node (parent-locked, SCHEMA.md "Datetime" — a move to root
 * would fail at the applier anyway).
 */

import { deriveDisplayName, parseDateNodeId, rendersAsInlineBlock } from "@notees/domain";

import type { ClientNode, CreateObjectInput } from "./workspace-client.js";

/** Read surface the gesture composes from (both client classes satisfy it). */
export interface ExtractReadSurface {
  getNode(id: string): ClientNode | undefined;
  /** Position-ordered, active-only children (the store's child order). */
  getChildren(id: string): ClientNode[];
}

/** Write surface the gesture submits through (the existing client op path). */
export interface ExtractWriteSurface {
  createObject(partial: CreateObjectInput): Promise<string>;
  moveObject(
    id: string,
    parentId: string | null,
    afterId?: string,
    beforeId?: string,
  ): Promise<void>;
}

export interface ExtractToPageOptions {
  /**
   * true = the children follow the extracted page (the link-block
   * replacement only); false/absent = the children stay in the original
   * page, reparented onto the link block.
   */
  keepChildren?: boolean;
}

/**
 * Extract an inline block to a root page. Returns the fresh link-block id
 * (its slot is the block's old position; its content is one mention of the
 * extracted node).
 */
export async function extractBlockToPage(
  reads: ExtractReadSurface,
  writes: ExtractWriteSurface,
  nodeId: string,
  options: ExtractToPageOptions = {},
): Promise<string> {
  const node = reads.getNode(nodeId);
  if (node === undefined || !node.isActive) {
    throw new Error(`extractBlockToPage: node ${nodeId} not found`);
  }
  if (!rendersAsInlineBlock(node)) {
    throw new Error("extractBlockToPage: only an inline block can be extracted to a page");
  }
  if (parseDateNodeId(nodeId) !== null) {
    throw new Error("extractBlockToPage: a date-chain node is parent-locked (SCHEMA.md Datetime)");
  }

  // rendersAsInlineBlock guarantees a parent. ALL reads happen before ANY
  // write: the write surface applies asynchronously and the child/sibling
  // order must be the pre-gesture state the anchors are computed from.
  const parentId = node.parentId as string;
  const siblings = reads.getChildren(parentId);
  const children = reads.getChildren(nodeId);
  const index = siblings.findIndex((sibling) => sibling.id === nodeId);
  const prev = index > 0 ? siblings[index - 1] : undefined;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : undefined;

  const linkBlockId = await writes.createObject({
    parentId,
    contentAst: [
      { type: "mention", targetNodeId: nodeId, text: deriveDisplayName(node) || "Untitled" },
    ],
    // Land exactly in the block's old slot: after the previous sibling when
    // there is one, otherwise before the next (the block is the first
    // child), otherwise the parent was empty of other children — append.
    ...(prev !== undefined
      ? { afterId: prev.id }
      : next !== undefined
        ? { beforeId: next.id }
        : {}),
  });
  await writes.moveObject(nodeId, null);
  if (options.keepChildren !== true) {
    // afterId chaining preserves the child order (first appends, each
    // following sibling lands after the previously moved one).
    let prevChildId: string | undefined;
    for (const child of children) {
      await writes.moveObject(child.id, linkBlockId, prevChildId);
      prevChildId = child.id;
    }
  }
  return linkBlockId;
}
