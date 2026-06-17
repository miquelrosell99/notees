/**
 * useTabNodeData — fetch display data (icon, color, text) for tab nodes.
 */
import { useMemo } from 'react';
import { useBatchNodes, useClasses } from '@/features/content';
import { nodeNameToText } from '@/features/queries';
import { getEffectiveIcon, getEffectiveColor } from '@/utils/nodeIcon';
import type { Node } from '@/types';

export interface TabNodeDisplayData {
  displayText: string;
  effectiveIcon: string | null | undefined;
  color: string | null | undefined;
}

export function useNodesDisplayData(nodeIds: number[]): Record<number, TabNodeDisplayData> {
  const { data: batchResult } = useBatchNodes(nodeIds);

  const { data: allClasses } = useClasses();

  return useMemo(() => {
    const result: Record<number, TabNodeDisplayData> = {};
    const nodes = batchResult?.nodes;
    if (!nodes) return result;

    for (const node of Object.values(nodes) as Node[]) {
      if (!node) continue;
      const effectiveClassIds = node.classes?.length ? node.classes : undefined;
      const effectiveIcon = getEffectiveIcon(node, allClasses, effectiveClassIds ?? undefined, null);
      const effectiveColor = getEffectiveColor(node, allClasses, effectiveClassIds, null);
      const text = (node.display_name && node.display_name !== node.name)
        ? node.display_name
        : nodeNameToText(node.name);
      const displayText = text?.trim() || (node.is_page ? '[Untitled]' : '[Block]');

      result[node.id] = {
        displayText,
        effectiveIcon,
        color: effectiveColor,
      };
    }
    return result;
  }, [batchResult, allClasses]);
}
