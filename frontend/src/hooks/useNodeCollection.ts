/**
 * useNodeCollection Hook
 * 
 * Shared logic for node collection components (NodeList, NodeSet, NodeListCore).
 * Handles grouping, sorting, collapsing, and item interaction.
 * 
 * This hook extracts the common patterns from multiple collection components
 * without merging them into a single "god component".
 */
import { useState, useMemo, useCallback } from 'react';
import type { ReactNode } from 'react';

// ==================== Types ====================

export interface CollectionItem<T = unknown> {
  /** The data item */
  data: T;
  /** Custom metadata for grouping/sorting */
  meta?: Record<string, unknown>;
}

export interface CollectionGroup<T = unknown> {
  /** Unique key for the group */
  key: string;
  /** Display label */
  label: string;
  /** Optional icon */
  icon?: ReactNode;
  /** Items in this group */
  items: CollectionItem<T>[];
  /** Whether group is collapsed */
  collapsed: boolean;
}

export interface UseNodeCollectionOptions<T> {
  /** Items to organize */
  items: CollectionItem<T>[];
  /** Optional groupBy function - returns group key for each item */
  groupBy?: (item: CollectionItem<T>) => string;
  /** Group labels (key -> label mapping) */
  groupLabels?: Record<string, string>;
  /** Group icons (key -> icon mapping) */
  groupIcons?: Record<string, ReactNode>;
  /** Sort groups by key */
  sortGroups?: (a: string, b: string) => number;
  /** Sort items within groups */
  sortItems?: (a: CollectionItem<T>, b: CollectionItem<T>) => number;
  /** Whether groups are collapsible */
  collapsible?: boolean;
  /** Initially collapsed groups */
  defaultCollapsed?: string[];
}

export interface UseNodeCollectionResult<T> {
  /** Organized groups (or single group if no groupBy) */
  groups: CollectionGroup<T>[];
  /** Set of collapsed group keys */
  collapsedGroups: Set<string>;
  /** Toggle a group's collapsed state */
  toggleGroup: (key: string) => void;
  /** Collapse all groups */
  collapseAll: () => void;
  /** Expand all groups */
  expandAll: () => void;
  /** Check if a group is collapsed */
  isCollapsed: (key: string) => boolean;
  /** Total item count */
  totalCount: number;
  /** Whether collection is empty */
  isEmpty: boolean;
}

// ==================== Hook ====================

export function useNodeCollection<T>({
  items,
  groupBy,
  groupLabels = {},
  groupIcons = {},
  sortGroups,
  sortItems,
  collapsible = true,
  defaultCollapsed = [],
}: UseNodeCollectionOptions<T>): UseNodeCollectionResult<T> {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(defaultCollapsed)
  );

  // Build groups from items
  const groups = useMemo((): CollectionGroup<T>[] => {
    if (!groupBy) {
      // No grouping - single group with all items
      const sortedItems = sortItems ? [...items].sort(sortItems) : items;
      return [{
        key: '__all__',
        label: '',
        items: sortedItems,
        collapsed: false,
      }];
    }

    // Group items by key
    const groupMap = new Map<string, CollectionItem<T>[]>();
    
    for (const item of items) {
      const key = groupBy(item);
      if (!groupMap.has(key)) {
        groupMap.set(key, []);
      }
      groupMap.get(key)!.push(item);
    }

    // Get sorted group keys
    let groupKeys = Array.from(groupMap.keys());
    if (sortGroups) {
      groupKeys = groupKeys.sort(sortGroups);
    }

    // Build group objects
    return groupKeys.map(key => {
      let groupItems = groupMap.get(key)!;
      if (sortItems) {
        groupItems = [...groupItems].sort(sortItems);
      }
      return {
        key,
        label: groupLabels[key] || key,
        icon: groupIcons[key],
        items: groupItems,
        collapsed: collapsedGroups.has(key),
      };
    });
  }, [items, groupBy, groupLabels, groupIcons, sortGroups, sortItems, collapsedGroups]);

  // Toggle single group
  const toggleGroup = useCallback((key: string) => {
    if (!collapsible) return;
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, [collapsible]);

  // Collapse all groups
  const collapseAll = useCallback(() => {
    if (!collapsible) return;
    setCollapsedGroups(new Set(groups.map(g => g.key)));
  }, [collapsible, groups]);

  // Expand all groups
  const expandAll = useCallback(() => {
    setCollapsedGroups(new Set());
  }, []);

  // Check if a specific group is collapsed
  const isCollapsed = useCallback((key: string) => {
    return collapsedGroups.has(key);
  }, [collapsedGroups]);

  // Computed values
  const totalCount = items.length;
  const isEmpty = items.length === 0;

  return {
    groups,
    collapsedGroups,
    toggleGroup,
    collapseAll,
    expandAll,
    isCollapsed,
    totalCount,
    isEmpty,
  };
}

export default useNodeCollection;
