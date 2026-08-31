/**
 * Library three-pane layout logic (Task 11) — pure, unit-tested functions.
 *
 * - Collection tree: nodes classed `collection` (hierarchy-aware, so user
 *   subclasses of collection count) nested by ordinary parent/child
 *   structure. A collection whose parent is not itself a collection is a
 *   root. `flattenCollectionTree` expands the tree into visible rows for the
 *   left pane.
 * - Pane selection: the three panes share one selection state — the active
 *   collection (`null` = the "All sources" pseudo-root) and the selected
 *   source shown in the inspector. Transitions are pure functions so the
 *   interaction logic is testable without rendering.
 *
 * Collection contents semantics (Decision 22) live in
 * `@/features/content/utils/collectionContents` and are reused as-is.
 */

import type { Node } from '@/types';
import {
  expandClassFilterUuids,
  nodeMatchesExpandedClassFilter,
  type ClassHierarchyEntry,
} from '@/core/query/classFilter';
import { libraryNodeName } from './libraryUtils';

/** A collection with its subcollections, recursively. */
export interface CollectionTreeNode {
  collection: Node;
  children: CollectionTreeNode[];
}

/**
 * Build the nested collection tree from a flat node list. Hierarchy-aware:
 * `collectionClassUuid` expands over the class tree, so nodes classed with a
 * user subclass of `collection` participate. Roots are collections whose
 * parent is not itself a collection; every level is sorted by display name.
 * Cycle-safe: a node already on the current path is never re-entered.
 */
export function buildCollectionTree(
  nodes: Node[],
  collectionClassUuid: string,
  classes: ClassHierarchyEntry[],
): CollectionTreeNode[] {
  const expanded = new Set(expandClassFilterUuids([collectionClassUuid], classes));
  const collections = nodes.filter((node) =>
    nodeMatchesExpandedClassFilter(node.classes_uuid, expanded),
  );
  const byUuid = new Map<string, Node>(collections.map((node) => [node.uuid, node]));

  const childrenOf = new Map<string, Node[]>();
  const roots: Node[] = [];
  for (const node of collections) {
    const parentUuid = node.parent_uuid;
    if (parentUuid && byUuid.has(parentUuid)) {
      const siblings = childrenOf.get(parentUuid);
      if (siblings) {
        siblings.push(node);
      } else {
        childrenOf.set(parentUuid, [node]);
      }
    } else {
      roots.push(node);
    }
  }

  const byName = (a: Node, b: Node) => libraryNodeName(a).localeCompare(libraryNodeName(b));
  const build = (node: Node, path: ReadonlySet<string>): CollectionTreeNode => {
    const nextPath = new Set(path).add(node.uuid);
    const children = (childrenOf.get(node.uuid) ?? [])
      .filter((child) => !nextPath.has(child.uuid))
      .sort(byName)
      .map((child) => build(child, nextPath));
    return { collection: node, children };
  };
  return roots.sort(byName).map((root) => build(root, new Set()));
}

/** A visible row in the flattened (expansion-aware) collection tree. */
export interface CollectionTreeRow {
  collection: Node;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * Depth-first flatten of the tree into the rows the left pane renders.
 * Children appear only when their parent is in `expandedUuids`.
 */
export function flattenCollectionTree(
  tree: CollectionTreeNode[],
  expandedUuids: ReadonlySet<string>,
): CollectionTreeRow[] {
  const rows: CollectionTreeRow[] = [];
  const walk = (nodes: CollectionTreeNode[], depth: number) => {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const expanded = expandedUuids.has(node.collection.uuid);
      rows.push({ collection: node.collection, depth, hasChildren, expanded });
      if (hasChildren && expanded) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(tree, 0);
  return rows;
}

/** Toggle one tree node's expansion state. */
export function toggleExpanded(
  expandedUuids: ReadonlySet<string>,
  collectionUuid: string,
): ReadonlySet<string> {
  const next = new Set(expandedUuids);
  if (next.has(collectionUuid)) {
    next.delete(collectionUuid);
  } else {
    next.add(collectionUuid);
  }
  return next;
}

/**
 * Shared selection state for the three panes.
 * `collectionUuid: null` is the "All sources" pseudo-root; `sourceUuid: null`
 * means the inspector is empty.
 */
export interface LibraryPaneSelection {
  collectionUuid: string | null;
  sourceUuid: string | null;
}

export const ALL_SOURCES_SELECTION: LibraryPaneSelection = {
  collectionUuid: null,
  sourceUuid: null,
};

/**
 * Select a collection (`null` = All sources). Changing the collection drops
 * the source selection — the previously selected source is not necessarily a
 * member of the newly listed set.
 */
export function selectCollection(
  selection: LibraryPaneSelection,
  collectionUuid: string | null,
): LibraryPaneSelection {
  if (selection.collectionUuid === collectionUuid) return selection;
  return { collectionUuid, sourceUuid: null };
}

/** Select a source for the inspector (no navigation). */
export function selectSource(
  selection: LibraryPaneSelection,
  sourceUuid: string,
): LibraryPaneSelection {
  if (selection.sourceUuid === sourceUuid) return selection;
  return { ...selection, sourceUuid };
}

/**
 * Drop the source selection when the selected source is no longer among the
 * visible sources (e.g. it was removed from the active collection).
 */
export function pruneSourceSelection(
  selection: LibraryPaneSelection,
  visibleSourceUuids: ReadonlySet<string>,
): LibraryPaneSelection {
  if (selection.sourceUuid && !visibleSourceUuids.has(selection.sourceUuid)) {
    return { ...selection, sourceUuid: null };
  }
  return selection;
}
