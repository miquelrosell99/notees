/**
 * useWhiteboard groups hook — group/ungroup operations
 */

import { useCallback } from 'react';
import type { WhiteboardGroup } from '@/types/whiteboard';
import { createElementId } from '@/types/whiteboard';

export function useWhiteboardGroups(
  groups: WhiteboardGroup[],
  updateGroups: (updater: (groups: WhiteboardGroup[]) => WhiteboardGroup[]) => void,
) {
  /** Find the group containing a given element ID, if any. */
  const getElementGroup = useCallback((elementId: string): WhiteboardGroup | null => {
    return groups.find(g => g.elementIds.includes(elementId)) ?? null;
  }, [groups]);

  /** Group the given element IDs together. */
  const groupElements = useCallback((ids: string[]) => {
    if (ids.length < 2) return;
    const newGroup: WhiteboardGroup = {
      id: createElementId(),
      elementIds: [...ids],
    };
    // Remove these elements from any existing groups first
    updateGroups(groups => [
      ...groups.map(g => ({ ...g, elementIds: g.elementIds.filter(id => !ids.includes(id)) })).filter(g => g.elementIds.length > 1),
      newGroup,
    ]);
  }, [updateGroups]);

  /** Ungroup: remove groups that contain all of the given selected IDs. */
  const ungroupElements = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    updateGroups(groups =>
      groups.filter(g => !g.elementIds.some(id => idSet.has(id)))
    );
  }, [updateGroups]);

  return { getElementGroup, groupElements, ungroupElements };
}
