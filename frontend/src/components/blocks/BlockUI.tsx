/**
 * BlockUI — Non-editable chrome for a block row.
 *
 * Bullet, icon, collapse arrow, depth indentation.
 * This replaces the first half of BlockNode.createDOM.
 */

import { Bullet } from './Bullet';
import type { Node } from '@/types/api';
import type { JSX } from 'react';
import './BlockUI.css';

interface BlockUIProps {
  node: Node;
  onCollapseToggle?: () => void;
  onNavigate?: (blockId: string) => void;
  onOpenInSidebar?: (blockId: string) => void;
  onContextMenu?: (nodeId: number, event: React.MouseEvent) => void;
}

export function BlockUI({
  node,
  onCollapseToggle,
  onNavigate,
  onOpenInSidebar,
  onContextMenu,
}: BlockUIProps): JSX.Element {
  const handleClick = () => {
    onNavigate?.(node.uuid);
  };

  const handleShiftClick = (_nodeId: number) => {
    onOpenInSidebar?.(node.uuid);
  };

  return (
    <div className="block-ui">
      <Bullet
        nodeId={node.id}
        icon={node.icon}
        isPage={node.is_page}
        hasChildren={node.has_children ?? false}
        collapsed={node.collapsed ?? false}
        onClick={handleClick}
        onShiftClick={handleShiftClick}
        onCollapseToggle={onCollapseToggle}
        onContextMenu={onContextMenu}
        size="sm"
      />
    </div>
  );
}
