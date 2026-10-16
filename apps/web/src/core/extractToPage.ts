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
 * one `object.create` (the link block, anchored with `beforeId` AT THE
 * SOURCE — it lands immediately ahead of the block, so the block's
 * departure leaves the link holding its exact slot on every position) +
 * `object.move` to the workspace root + one `object.move` per reparented
 * child (afterId chaining, the merge-plan children precedent). Every
 * client converges by replay with zero applier changes; the wire stays
 * untouched.
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
  // write: the write surface applies asynchronously and the child order
  // must be the pre-gesture state the reparent plan is computed from.
  const parentId = node.parentId as string;
  const children = reads.getChildren(nodeId);

  const linkBlockId = await writes.createObject({
    parentId,
    contentAst: [
      { type: "mention", targetNodeId: nodeId, text: deriveDisplayName(node) || "Untitled" },
    ],
    // Anchor BEFORE the block itself: the applier's beforeId midpoint lands
    // the link immediately ahead of the block on EVERY position (first,
    // middle, last), and the block's own departure to the root leaves the
    // link holding its exact slot. Anchoring against the source also beats
    // sibling lookups — a stale cached children read can miss the block
    // (index -1) or mis-order siblings, which appended the link at the end
    // (the reported "link block lands last" bug). The source node is always
    // present in the store.
    beforeId: nodeId,
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
