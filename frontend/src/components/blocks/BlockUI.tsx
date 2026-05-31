/**
 * BlockUI — Non-editable chrome for a block row.
 *
 * Bullet, icon, collapse arrow, depth indentation.
 * This replaces the first half of BlockNode.createDOM.
 */

import { Bullet } from './Bullet';
import { Icon } from '@/components/core/icons';
import type { Node } from '@/types/api';
import type { JSX } from 'react';
import './BlockUI.css';
import type { PresenceUser } from '@/stores/livePresenceStore';
import { useTaskActions } from '@/hooks/useTaskActions';

interface BlockUIProps {
  node: Node;
  onCollapseToggle?: () => void;
  onNavigate?: (blockId: string) => void;
  onOpenInSidebar?: (blockId: string) => void;
  onContextMenu?: (nodeId: number, event: React.MouseEvent) => void;
  /** Remote users currently editing this block (for lock indicator). */
  lockedBy?: PresenceUser[];
}

export function BlockUI({
  node,
  onCollapseToggle,
  onNavigate,
  onOpenInSidebar,
  onContextMenu,
  lockedBy,
}: BlockUIProps): JSX.Element {
  const { isTask, taskStatus, toggleTask } = useTaskActions(node);

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
        taskStatus={isTask ? taskStatus : undefined}
        onTaskToggle={toggleTask}
      />
      {lockedBy && lockedBy.length > 0 && (
        <div className="block-ui__lock" title={`Editing by ${lockedBy.map((u) => u.name).join(', ')}`}>
          <Icon path="mdi mdi-lock-outline" size={0.7} color={lockedBy[0].color} />
        </div>
      )}
    </div>
  );
}
