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
import type { PresenceUser } from '@/stores/livePresenceStore';
import { useTaskActions } from '@/hooks/useTaskActions';
import './BlockUI.css';

interface BlockUIProps {
  node: Node;
  /** Resolved icon override (e.g. inherited from classes). Falls back to node.icon. */
  icon?: string | null;
  /** Override hasChildren (e.g. query blocks without tree children). */
  hasChildren?: boolean;
  /** Override collapsed state (e.g. when expandAll is active). */
  collapsed?: boolean;
  onCollapseToggle?: () => void;
  onNavigate?: (blockId: string) => void;
  onOpenInSidebar?: (blockId: string) => void;
  onContextMenu?: (nodeId: number, event: React.MouseEvent) => void;
  /** Whether the block row is being hovered */
  isHovered?: boolean;
  /** Remote users currently editing this block (for lock indicator). */
  lockedBy?: PresenceUser[];
  /** Remote users currently focused on this block (presence). */
  presenceUsers?: PresenceUser[];
  /** Remote users currently typing in this block (ephemeral). */
  typingUsers?: PresenceUser[];
}

export function BlockUI({
  node,
  icon: iconOverride,
  hasChildren: hasChildrenOverride,
  collapsed: collapsedProp,
  onCollapseToggle,
  onNavigate,
  onOpenInSidebar,
  onContextMenu,
  isHovered,
  lockedBy,
  presenceUsers,
  typingUsers,
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
        icon={iconOverride ?? node.icon}
        isPage={node.is_page}
        hasChildren={hasChildrenOverride ?? (node.has_children ?? false)}
        collapsed={collapsedProp ?? node.collapsed ?? false}
        onClick={handleClick}
        onShiftClick={handleShiftClick}
        onCollapseToggle={onCollapseToggle}
        onContextMenu={onContextMenu}
        isHovered={isHovered}
        size="sm"
      />
      {isTask && (
        <input
          type="checkbox"
          className="block-ui__task-checkbox"
          checked={taskStatus === 'Done'}
          onChange={toggleTask}
          onClick={(e) => e.stopPropagation()}
          title={taskStatus ?? 'Task'}
        />
      )}
      {presenceUsers && presenceUsers.length > 0 && (
        <div className="block-ui__presence">
          {presenceUsers.map((u) => (
            <span
              key={u.id}
              className="block-ui__presence-avatar"
              title={`${u.name} is here`}
              style={{ backgroundColor: u.color || '#888' }}
            >
              {u.name.charAt(0).toUpperCase()}
            </span>
          ))}
        </div>
      )}
      {lockedBy && lockedBy.length > 0 && (
        <div className="block-ui__lock" title={`Editing by ${lockedBy.map((u) => u.name).join(', ')}`}>
          <Icon path="mdi mdi-lock-outline" size={0.7} color={lockedBy[0].color} />
        </div>
      )}
      {node.is_private && (
        <div className="block-ui__private" title="Private">
          <Icon path="mdi mdi-eye-off-outline" size={0.7} color="var(--color-outline)" />
        </div>
      )}
      {typingUsers && typingUsers.length > 0 && (
        <div className="block-ui__typing">
          {typingUsers.map((u) => (
            <span
              key={u.id}
              className="block-ui__typing-dot"
              title={`${u.name} is typing…`}
              style={{ backgroundColor: u.color || '#888' }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
