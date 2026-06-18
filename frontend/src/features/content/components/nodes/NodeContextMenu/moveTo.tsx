import { useCallback } from 'react';
import { useUpdateNode } from '@/features/content';
import { NodeSelector } from '../NodeSelector';
import type { Node } from '@/types';

interface MoveToSubmenuProps {
  node: Node;
  onClose: () => void;
  onParentChange?: (parentId: number | null) => void;
}

export function MoveToSubmenu({ node, onClose, onParentChange }: MoveToSubmenuProps) {
  const updateNode = useUpdateNode();

  const handleSelect = useCallback(
    (val: number | number[] | null) => {
      const parentId = typeof val === 'number' ? val : null;
      updateNode.mutate({ id: node.id, data: { parent_id: parentId } });
      onParentChange?.(parentId);
      onClose();
    },
    [node.id, updateNode, onParentChange, onClose],
  );

  return (
    <NodeSelector
      trigger="select"
      value={node.parent_id ?? null}
      searchMode={node.is_page ? 'pages' : 'all'}
      excludeNodeId={node.id}
      placeholder={node.is_page ? 'Search pages...' : 'Search pages & blocks...'}
      onChange={handleSelect}
      allowCreate={false}
      size="sm"
      className="move-to-submenu"
    />
  );
}
