/**
 * Ordering for class-property edges that matches backend enforcement.
 */
import type { ClassProperty } from '@/types/api';

/**
 * Order class-property edges the way backend enforcement resolves them
 * (repository.get_class_property_edges_for_node: ORDER BY depth, then class
 * position — all direct class edges at depth 0 first, then inherited ones).
 *
 * Each per-class list must be ordered nearest-first (direct edges, then
 * ancestors by ascending depth — the backend's get_all_inherited_properties
 * ordering). A stable partition into direct (edge.class_node_uuid === the
 * class it was fetched for) and inherited buckets reproduces the backend
 * order, so first-occurrence-wins dedup agrees with enforcement: an
 * inherited edge of class A can no longer shadow a direct edge of class B.
 *
 * Note: inherited edges keep per-class grouping (class order), whereas the
 * backend interleaves them by exact depth across classes — depths are not
 * recoverable from the API payload. The partition matches the backend
 * whenever the winning edge is direct, which is the enforcement-relevant
 * case (depth 0 always beats depth >= 1 there too).
 */
export function orderClassPropertyEdges(
  classUuids: string[],
  perClassEdges: (ClassProperty[] | undefined)[],
): ClassProperty[] {
  const direct: ClassProperty[] = [];
  const inherited: ClassProperty[] = [];
  classUuids.forEach((classId, index) => {
    const list = perClassEdges[index];
    if (!list) return;
    for (const edge of list) {
      (edge.class_node_uuid === classId ? direct : inherited).push(edge);
    }
  });
  return [...direct, ...inherited];
}
