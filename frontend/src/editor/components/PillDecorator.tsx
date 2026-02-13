/**
 * PillDecorator — React component rendered inside PillNode (DecoratorNode).
 *
 * Lexical portals this into the PillNode's DOM element (<span class="node-pill-wrapper">).
 * Fetches node data by UUID and renders a lightweight inline pill.
 */

import { useMemo } from 'react';
import { useNodeByUuid } from '@/hooks/useNodeQueries';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { useClasses } from '@/hooks';
import { NodeIcon } from '@/components/core/icons';

export interface PillDecoratorProps {
  linkId: string;
  refType: 'node' | 'class';
}

export function PillDecorator({ linkId, refType }: PillDecoratorProps) {
  const { data: node } = useNodeByUuid(linkId);
  const { data: allClasses } = useClasses();

  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allClasses), [node, allClasses]);

  const displayText = useMemo(() => {
    if (!node) return linkId.slice(0, 8) + '…';
    const text = nodeNameToText(node.name);
    if (!text || text.trim() === '') {
      return node.is_page ? '[Untitled Page]' : '[Empty Block]';
    }
    if (!node.is_page && text.length > 50) {
      return text.slice(0, 50) + '…';
    }
    return text;
  }, [node, linkId]);

  const isPage = node?.is_page ?? true;
  const nodeColor = node?.color || undefined;

  return (
    <span
      className="node-pill-inner"
      data-ref-type={refType}
      style={nodeColor ? { textDecorationColor: nodeColor, color: nodeColor } : undefined}
    >
      {effectiveIcon && (
        <span className="node-pill-icon">
          <NodeIcon icon={effectiveIcon} isPage={isPage} size="xs" />
        </span>
      )}
      <span className="node-pill-text">
        {displayText}
      </span>
    </span>
  );
}
