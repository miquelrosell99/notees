import { useCallback } from 'react';
import { useUpdateNode } from '@/features/content';
import { NodeSelector } from '../NodeSelector';
import type { Node } from '@/types';

interface MoveToSubmenuProps {
  node: Node;
  onClose: () => void;
  onParentChange?: (parentId: string | null) => void;
}

export function MoveToSubmenu({ node, onClose, onParentChange }: MoveToSubmenuProps) {
  const updateNode = useUpdateNode();

  const handleSelect = useCallback(
    (val: string | string[] | null) => {
      if (val == null) {
        updateNode.mutate({ nodeUuid: node.uuid, data: { parent_uuid: null } });
        onParentChange?.(null);
        onClose();
        return;
      }
      const selectedUuid = typeof val === 'string' ? val : val[0];
      updateNode.mutate({ nodeUuid: node.uuid, data: { parent_uuid: selectedUuid } });
      onParentChange?.(selectedUuid);
      onClose();
    },
    [node.uuid, updateNode, onParentChange, onClose],
  );

  return (
    <NodeSelector
      trigger="select"
      value={node.parent_uuid ?? null}
      searchMode={node.is_page ? 'pages' : 'all'}
      excludeNodeId={node.uuid}
      placeholder={node.is_page ? 'Search pages...' : 'Search pages & blocks...'}
      onChange={handleSelect}
      allowCreate={false}
      size="sm"
      className="move-to-submenu"
    />
  );
}
