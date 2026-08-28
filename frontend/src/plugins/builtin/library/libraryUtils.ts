/**
 * Library view logic — pure, unit-tested functions behind the Library plugin UI.
 *
 * - Section filtering is hierarchy-aware (a `book` section also matches user
 *   classes extending `book`) via `expandClassFilterUuids`.
 * - Grouping (Decision 27): Work/Edition is an optional nesting pattern over
 *   ordinary parent/child structure. A source whose parent is itself a source
 *   renders as an Edition collapsed beneath its Work; everything else is a
 *   top-level row. Flat mode renders every source as its own row.
 * - Covers (Decision 28): the node's `cover` property, falling back to
 *   `parent.cover` (Work → Edition), null otherwise (neutral placeholder).
 */

import type { Node } from '@/types';
import type { QueryAST } from '@/types/queryAST';
import type { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import {
  expandClassFilterUuids,
  nodeMatchesExpandedClassFilter,
  type ClassHierarchyEntry,
} from '@/core/query/classFilter';
import { nodeNameToText } from '@/features/queries';

export type LibraryViewMode = 'table' | 'cards';
export type LibraryGrouping = 'flat' | 'grouped';

export interface LibrarySection {
  /** Stable section id, also used as the URL/state key. */
  id: string;
  label: string;
  /** System class name backing the section; 'source' for the all-sources view. */
  className: keyof typeof SYSTEM_CLASS_UUIDS;
}

/** Top-level sections of the Library view, in display order. */
export const LIBRARY_SECTIONS: readonly LibrarySection[] = [
  { id: 'all', label: 'All Sources', className: 'source' },
  { id: 'books', label: 'Books', className: 'book' },
  { id: 'papers', label: 'Papers', className: 'paper' },
  { id: 'articles', label: 'Articles', className: 'article' },
  { id: 'theses', label: 'Theses', className: 'thesis' },
  { id: 'documents', label: 'Documents', className: 'document' },
  { id: 'movies', label: 'Movies', className: 'movie' },
  { id: 'authors', label: 'Authors', className: 'agent' },
] as const;

/** class:<name> query AST — hierarchy-aware by construction (closure-aware compiler). */
export function buildLibraryQueryAst(classUuid: string, idSuffix: string): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    id: `library_${idSuffix}`,
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        {
          type: 'condition',
          condition_type: 'class',
          operator: 'is_any_of',
          class_uuids: [classUuid],
        },
      ],
    },
  };
}

export function getLibrarySection(id: string): LibrarySection {
  return LIBRARY_SECTIONS.find((section) => section.id === id) ?? LIBRARY_SECTIONS[0];
}

/** Display name for a node (content AST → plain text). */
export function libraryNodeName(node: Node): string {
  return nodeNameToText(node.name) || 'Untitled';
}

/**
 * Filter nodes to a Library section. Hierarchy-aware: the section class filter
 * expands over the class tree, so a node classed with a user subclass of
 * `book` still lists under Books. Kind-agnostic: pages and blocks both match.
 */
export function filterNodesBySection(
  nodes: Node[],
  sectionClassUuid: string,
  classes: ClassHierarchyEntry[],
): Node[] {
  const expanded = new Set(expandClassFilterUuids([sectionClassUuid], classes));
  return nodes
    .filter((node) => nodeMatchesExpandedClassFilter(node.classes_uuid, expanded))
    .sort((a, b) => libraryNodeName(a).localeCompare(libraryNodeName(b)));
}

/** A Work row with its Editions (sources nested directly beneath it). */
export interface WorkGroup {
  work: Node;
  editions: Node[];
}

/**
 * Group sources into Work → Edition groups over ordinary parent/child
 * structure. A source whose `parent_uuid` is itself a source in the same set
 * becomes an edition of that parent; all other sources are top-level rows
 * (works without editions render as plain rows).
 *
 * Grouping is computed within the already section-filtered set: an edition
 * whose work was filtered out promotes to a top-level row.
 */
export function groupSourcesIntoWorks(sources: Node[]): WorkGroup[] {
  const inSet = new Set(sources.map((node) => node.uuid));
  const editionsByWork = new Map<string, Node[]>();
  const works: Node[] = [];

  for (const node of sources) {
    const parentUuid = node.parent_uuid;
    if (parentUuid && inSet.has(parentUuid)) {
      const editions = editionsByWork.get(parentUuid);
      if (editions) {
        editions.push(node);
      } else {
        editionsByWork.set(parentUuid, [node]);
      }
    } else {
      works.push(node);
    }
  }

  const groups = works.map((work) => ({
    work,
    editions: (editionsByWork.get(work.uuid) ?? [])
      .slice()
      .sort((a, b) => libraryNodeName(a).localeCompare(libraryNodeName(b))),
  }));
  return groups.sort((a, b) => libraryNodeName(a.work).localeCompare(libraryNodeName(b.work)));
}

/**
 * Resolve the cover asset UUID for a source: the node's own `cover` property,
 * falling back to its parent's cover (Work → Edition). `allSourcesByUuid` must
 * cover potential parents (pass the unfiltered source map), or null when
 * neither the node nor its parent has a cover.
 */
export function resolveCoverAssetUuid(
  node: Node,
  allSourcesByUuid: ReadonlyMap<string, Node>,
): string | null {
  const own = node.properties_uuid?.[SYSTEM_PROPERTY_UUIDS.cover];
  if (typeof own === 'string' && own) return own;

  const parentUuid = node.parent_uuid;
  if (!parentUuid) return null;
  const parent = allSourcesByUuid.get(parentUuid);
  if (!parent) return null;
  const parentCover = parent.properties_uuid?.[SYSTEM_PROPERTY_UUIDS.cover];
  return typeof parentCover === 'string' && parentCover ? parentCover : null;
}

/**
 * Resolve the `authors` property (agent node UUIDs) to display names.
 * Unknown/unresolved UUIDs are skipped.
 */
export function resolveAuthorNames(
  node: Node,
  agentsByUuid: ReadonlyMap<string, Node>,
): string[] {
  const raw = node.properties_uuid?.[SYSTEM_PROPERTY_UUIDS.authors];
  const uuids = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : [];
  const names: string[] = [];
  for (const uuid of uuids) {
    if (typeof uuid !== 'string') continue;
    const agent = agentsByUuid.get(uuid);
    if (agent) names.push(libraryNodeName(agent));
  }
  return names;
}

/** Read a text-ish system property (isbn, doi, citekey, publisher, ...) for table cells. */
export function readTextProperty(node: Node, propertyUuid: string): string {
  const value = node.properties_uuid?.[propertyUuid];
  return typeof value === 'string' ? value : '';
}
