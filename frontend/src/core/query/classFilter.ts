/**
 * Hierarchy-aware class filter resolution (Decision 9, generic fix).
 *
 * Node pickers, suggestions, and list filters historically matched
 * `class_filter_uuids` by exact UUID, so a filter on `agent` never matched
 * `person`/`organization` nodes even though the query AST compilers descend
 * the `class_hierarchy` closure (see compileToSqlite.ts
 * `generateClassCondition`). The helpers here expand a set of filter class
 * UUIDs to include every descendant class, so exact membership checks against
 * the expanded set behave like the query compilers — for any superclass, not
 * just `agent`.
 *
 * Two variants are provided:
 * - `expandClassFilterUuids` — pure, client-side, walks `extends_uuid` edges
 *   from the class list already loaded in the UI (plus the static system
 *   extends edges as a fallback so system subclasses resolve before the class
 *   list loads).
 * - `expandClassFilterUuidsFromDb` — worker/store-side, resolves descendants
 *   through the `class_hierarchy` closure table.
 */

import type { Database } from 'sql.js';
import { queryAll } from '../db/sqlite';
import { SYSTEM_CLASS_EXTENDS, SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';

/** Minimal class shape needed to walk the hierarchy client-side. */
export interface ClassHierarchyEntry {
  uuid: string;
  extends_uuid?: string[] | null;
}

type SystemClassName = keyof typeof SYSTEM_CLASS_UUIDS;

/** Static system extends edges as UUID -> parent UUIDs (fallback for live data). */
const SYSTEM_EXTENDS_BY_UUID: ReadonlyMap<string, string[]> = new Map(
  Object.entries(SYSTEM_CLASS_EXTENDS).map(([name, parents]) => [
    SYSTEM_CLASS_UUIDS[name as SystemClassName],
    parents.map((parent) => SYSTEM_CLASS_UUIDS[parent as SystemClassName]),
  ]),
);

/**
 * Expand filter class UUIDs to the set of class UUIDs that satisfy the filter:
 * the filters themselves plus every descendant class (direct and transitive).
 *
 * The result is safe to use with exact membership checks against a node's
 * directly-assigned classes. Expansion is idempotent, so passing an expanded
 * set through a closure-aware SQL compiler (queryNodes/search) changes
 * nothing.
 */
export function expandClassFilterUuids(
  filterUuids: string[],
  classes: ClassHierarchyEntry[],
): string[] {
  if (filterUuids.length === 0) return [];

  // child -> parents (live class data wins; static system edges fill gaps).
  const parentsByChild = new Map<string, string[]>();
  for (const cls of classes) {
    if (cls.extends_uuid && cls.extends_uuid.length > 0) {
      parentsByChild.set(cls.uuid, cls.extends_uuid);
    }
  }
  for (const [child, parents] of SYSTEM_EXTENDS_BY_UUID) {
    if (!parentsByChild.has(child)) {
      parentsByChild.set(child, parents);
    }
  }

  // Invert to parent -> children for descendant traversal.
  const childrenByParent = new Map<string, string[]>();
  for (const [child, parents] of parentsByChild) {
    for (const parent of parents) {
      const children = childrenByParent.get(parent);
      if (children) {
        children.push(child);
      } else {
        childrenByParent.set(parent, [child]);
      }
    }
  }

  const expanded = new Set<string>();
  const stack = [...filterUuids];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (expanded.has(current)) continue;
    expanded.add(current);
    for (const child of childrenByParent.get(current) ?? []) {
      stack.push(child);
    }
  }
  return [...expanded];
}

/**
 * Expand filter class UUIDs through the `class_hierarchy` closure table.
 * Returns a Set for O(1) membership checks against a node's class_ids.
 */
export function expandClassFilterUuidsFromDb(
  db: Database,
  filterUuids: string[],
): Set<string> {
  const expanded = new Set(filterUuids);
  if (filterUuids.length === 0) return expanded;
  const placeholders = filterUuids.map(() => '?').join(',');
  const rows = queryAll<{ class_id: string }>(
    db,
    `SELECT class_id FROM class_hierarchy WHERE ancestor_id IN (${placeholders})`,
    filterUuids,
  );
  for (const row of rows) {
    expanded.add(row.class_id);
  }
  return expanded;
}

/**
 * Exact membership check against an expanded filter set. Pair with
 * `expandClassFilterUuids` / `expandClassFilterUuidsFromDb`.
 */
export function nodeMatchesExpandedClassFilter(
  nodeClassIds: string[] | null | undefined,
  expandedFilter: Set<string>,
): boolean {
  if (!nodeClassIds || nodeClassIds.length === 0) return false;
  return nodeClassIds.some((id) => expandedFilter.has(id));
}
