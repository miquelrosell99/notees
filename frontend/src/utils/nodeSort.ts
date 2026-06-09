/**
 * Node sorting utilities.
 *
 * All sorting is performed at the view level — the query layer fetches and
 * filters, views sort, and projection renders in the order given.
 */
import type { Node, Property } from '@/types';
import { parseDateUuid } from '@/types/api';
import type { SortEntry } from '@/components/core/Table';

// ─── Helpers ──────────────────────────────────────────────────────

/** Check whether a node represents a date (day, month, or year). */
export function isDateNode(node: Node): boolean {
  return !!(node.is_daily || node.is_monthly || node.is_yearly);
}

/**
 * Extract a comparable numeric value from a date node's UUID so that
 * more-recent dates sort first (descending).
 * Returns `0` when the UUID can't be parsed.
 */
function dateNodeSortKey(node: Node): number {
  const info = parseDateUuid(node.uuid);
  if (!info) return 0;
  // Encode as YYYYMMDD numeric – month/year nodes get DD=0, year nodes MM=0
  return info.year * 10000 + (info.month ?? 0) * 100 + (info.day ?? 0);
}

// ─── Comparators ──────────────────────────────────────────────────

/**
 * Compare two nodes by `sequence` (ascending).
 * Nodes without a sequence are pushed to the end.
 */
export function compareBySequence(a: Node, b: Node): number {
  return (a.sequence ?? Infinity) - (b.sequence ?? Infinity);
}

/**
 * Compare two nodes using the "dates-first-descending, then alphabetically"
 * ordering used for group-by parent / root nodes.
 *
 * 1. Date nodes come before non-date nodes.
 * 2. Among date nodes, sort descending (newest first).
 * 3. Among non-date nodes, sort alphabetically by name (case-insensitive).
 */
export function compareDateFirstAlpha(a: Node, b: Node): number {
  const aKey = dateNodeSortKey(a);
  const bKey = dateNodeSortKey(b);
  const aIsDate = aKey > 0;
  const bIsDate = bKey > 0;

  if (aIsDate && bIsDate) {
    // Both dates → chronological ascending (year → month → day)
    return aKey - bKey;
  }
  if (aIsDate) return -1; // date before non-date
  if (bIsDate) return 1;

  // Both non-date → alphabetical
  const aName = (a.name ?? '').toLowerCase();
  const bName = (b.name ?? '').toLowerCase();
  return aName.localeCompare(bName);
}

/**
 * Compare two nodes by `write_date` (descending — most recently modified first).
 */
export function compareByWriteDateDesc(a: Node, b: Node): number {
  const aDate = a.write_date ? new Date(a.write_date).getTime() : 0;
  const bDate = b.write_date ? new Date(b.write_date).getTime() : 0;
  return bDate - aDate; // descending
}

/**
 * Compare two nodes by `create_date` (descending — newest first).
 */
export function compareByCreateDateDesc(a: Node, b: Node): number {
  const aDate = a.create_date ? new Date(a.create_date).getTime() : 0;
  const bDate = b.create_date ? new Date(b.create_date).getTime() : 0;
  return bDate - aDate;
}

// ─── Convenience sort functions ───────────────────────────────────

/** Sort an array of nodes by sequence (ascending). Returns a new array. */
export function sortBySequence(nodes: Node[]): Node[] {
  return [...nodes].sort(compareBySequence);
}

/**
 * Sort group-by parent nodes: dates first (descending), then alphabetical.
 * Returns a new array.
 */
export function sortDateFirstAlpha(nodes: Node[]): Node[] {
  return [...nodes].sort(compareDateFirstAlpha);
}

/**
 * Compare two nodes for the All Pages view.
 * @deprecated Use compareDateFirstAlpha directly; kept for backwards compatibility.
 */
export function compareAllPagesSort(a: Node, b: Node): number {
  return compareDateFirstAlpha(a, b);
}

/** Sort nodes by write_date descending. Returns a new array. */
export function sortByWriteDateDesc(nodes: Node[]): Node[] {
  return [...nodes].sort(compareByWriteDateDesc);
}

/**
 * Compare two property values with type-aware logic.
 */
function comparePropertyValues(aVal: unknown, bVal: unknown, prop: Property | undefined): number {
  if (aVal == null && bVal == null) return 0;
  if (aVal == null) return 1;
  if (bVal == null) return -1;

  switch (prop?.type) {
    case 'integer':
    case 'float':
      return (aVal as number) - (bVal as number);
    case 'boolean':
      return (aVal ? 1 : 0) - (bVal ? 1 : 0);
    case 'selection': {
      const getOptionName = (v: unknown): string => {
        if (typeof v === 'number') {
          return prop.options?.find((o) => o.id === v)?.name ?? String(v);
        }
        if (v && typeof v === 'object' && 'id' in v) {
          return prop.options?.find((o) => o.id === (v as { id: number }).id)?.name ?? String(v);
        }
        return String(v);
      };
      return getOptionName(aVal).localeCompare(getOptionName(bVal));
    }
    default:
      return String(aVal).localeCompare(String(bVal));
  }
}

/**
 * Compare two nodes by a list of sort entries (multi-column sort).
 * Supports name, write_date, create_date, sequence, and property columns.
 */
export function compareBySortEntries(
  a: Node,
  b: Node,
  sortEntries: SortEntry[],
  allProperties: Property[]
): number {
  for (const entry of sortEntries) {
    let comparison = 0;

    switch (entry.key) {
      case 'name': {
        comparison = compareDateFirstAlpha(a, b);
        break;
      }
      case 'write_date': {
        const aTime = a.write_date ? new Date(a.write_date).getTime() : 0;
        const bTime = b.write_date ? new Date(b.write_date).getTime() : 0;
        comparison = aTime - bTime;
        break;
      }
      case 'create_date': {
        const aTime = a.create_date ? new Date(a.create_date).getTime() : 0;
        const bTime = b.create_date ? new Date(b.create_date).getTime() : 0;
        comparison = aTime - bTime;
        break;
      }
      case 'sequence': {
        comparison = (a.sequence ?? Infinity) - (b.sequence ?? Infinity);
        break;
      }
      default: {
        if (entry.key.startsWith('property_')) {
          const propertyId = parseInt(entry.key.replace('property_', ''), 10);
          const prop = allProperties.find((p) => p.id === propertyId);
          const aVal = a.properties?.[propertyId];
          const bVal = b.properties?.[propertyId];
          comparison = comparePropertyValues(aVal, bVal, prop);
        }
        break;
      }
    }

    if (comparison !== 0) {
      return entry.direction === 'asc' ? comparison : -comparison;
    }
  }
  return 0;
}

/**
 * Sort an array of nodes by sort entries. Returns a new array.
 */
export function sortNodesByEntries(
  nodes: Node[],
  sortEntries: SortEntry[],
  allProperties: Property[]
): Node[] {
  if (sortEntries.length === 0) return nodes;
  return [...nodes].sort((a, b) => compareBySortEntries(a, b, sortEntries, allProperties));
}
