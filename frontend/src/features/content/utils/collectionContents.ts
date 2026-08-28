/**
 * Collection semantics (Decision 22).
 *
 * A collection is a root-level page classed `collection`. Its contents are the
 * deduplicated union of:
 *
 *   1. sources nested under it recursively (subcollections included), and
 *   2. sources that link to it,
 *
 * always intersected with `class:source` (hierarchy-aware — books, papers,
 * block-classed sources, ...). There is no membership table; nesting is the
 * "home" collection and links express additional memberships.
 *
 * The two query AST builders below compile against the local-first query
 * runtime (`compileToSqlite`), which descends the class_hierarchy closure for
 * class conditions, so the `class:source` intersection is hierarchy-aware by
 * construction. `computeCollectionContents` is the pure union/dedupe step,
 * unit-tested without a store.
 */

import type { Node } from '@/types';
import type { GroupNode, QueryAST } from '@/types/queryAST';
import { nodeNameToText } from '@/features/queries';

/** AND(class:source, has_ancestor(collection)) — sources nested under the collection, recursively. */
export function buildCollectionNestedQueryAst(
  collectionUuid: string,
  sourceClassUuid: string,
): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    id: `collection_nested_${collectionUuid}`,
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        {
          type: 'condition',
          condition_type: 'class',
          operator: 'is_any_of',
          class_uuids: [sourceClassUuid],
        },
        {
          type: 'condition',
          condition_type: 'parent_path',
          operator: 'has_ancestor',
          ancestor_uuids: [collectionUuid],
        },
      ] as GroupNode['children'],
    },
  };
}

/** AND(class:source, references(collection)) — sources linking to the collection. */
export function buildCollectionLinkedQueryAst(
  collectionUuid: string,
  sourceClassUuid: string,
): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    id: `collection_linked_${collectionUuid}`,
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        {
          type: 'condition',
          condition_type: 'class',
          operator: 'is_any_of',
          class_uuids: [sourceClassUuid],
        },
        {
          type: 'condition',
          condition_type: 'reference',
          operator: 'references',
          target_uuid: collectionUuid,
        },
      ] as GroupNode['children'],
    },
  };
}

/**
 * Deduped union of nested and linked sources (a source that both nests under
 * and links to the collection appears exactly once), sorted by display name.
 */
export function computeCollectionContents(nested: Node[], linked: Node[]): Node[] {
  const byUuid = new Map<string, Node>();
  for (const node of [...nested, ...linked]) {
    if (!byUuid.has(node.uuid)) {
      byUuid.set(node.uuid, node);
    }
  }
  return Array.from(byUuid.values()).sort((a, b) =>
    nodeNameToText(a.name).localeCompare(nodeNameToText(b.name)),
  );
}

/**
 * Exclude collection-classed pages from a page list (the regular notes page
 * list does not show collections — they are managed through their own view).
 */
export function filterOutCollectionPages<T extends Pick<Node, 'classes_uuid'>>(
  pages: T[],
  collectionClassUuid: string | null | undefined,
): T[] {
  if (!collectionClassUuid) return pages;
  return pages.filter((page) => !page.classes_uuid?.includes(collectionClassUuid));
}
