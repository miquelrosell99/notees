/**
 * childQuery — the body's item-resolution factory (the main-content
 * restructure, S4/M1): the body of both modes is the plain NodeCollection
 * dispatcher, fed by this one factory living beside the SectionSpec
 * factories. Page mode: the node's children as top-level items. Block mode
 * (`showRoot`): the node itself as the single root item with its children
 * under it — the M2-verified item-shape difference (ReferenceSubtree
 * renders the root BlockRow + recursive children; no NodeCollectionProps
 * addition).
 *
 * M19: children classed `comment` are excluded at EVERY level, with their
 * whole subtrees — comments never render in the main body (the v1
 * precedent, NodeTreeProjection's `is_comment` skip); they surface only in
 * the Comments section of the context column (components/CommentsSection.tsx,
 * landed with S7a).
 */

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, WorkspaceClient } from "@/core/workspace-client.js";

import type { NodeCollectionItem } from "../views/index.js";

type AnyClient = WorkspaceClient | WorkerClient;

export interface ChildQueryOptions {
  /**
   * Block mode: the node itself is the single root item (`items=[{node,
   * children}]`); false (default, page mode): its children as siblings.
   */
  showRoot?: boolean;
}

/** Comment-classed rows never render in the main body (whole subtree cut). */
function notComment(entry: BlockTreeNode): boolean {
  return !entry.node.classIds.includes(SYSTEM_CLASS_UUIDS.comment);
}

/** BlockTreeNode → the collection input shape (recursive, comments cut). */
function toItem(entry: BlockTreeNode): NodeCollectionItem {
  return {
    node: entry.node,
    children: entry.children.filter(notComment).map(toItem),
  };
}

export function childQuery(
  client: AnyClient,
  nodeId: string,
  { showRoot = false }: ChildQueryOptions = {},
): NodeCollectionItem[] {
  const tree = client.getBlockTree(nodeId).filter(notComment).map(toItem);
  if (!showRoot) return tree;
  const root = client.getNode(nodeId);
  return root === undefined ? [] : [{ node: root, children: tree }];
}
