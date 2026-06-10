/**
 * BlockUI — Non-editable chrome for a block row.
 *
 * Bullet, icon, collapse arrow, depth indentation.
 * This replaces the first half of BlockNode.createDOM.
 */

import { useCallback } from 'react';
import { Bullet } from './Bullet';
import { Icon } from '@/components/ui/icons';
import type { Node } from '@/types/api';
import type { JSX } from 'react';
import type { PresenceUser } from '@/stores/livePresenceStore';
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
  const handleClick = () => {
    onNavigate?.(node.uuid);
  };

  const handleShiftClick = (_nodeId: number) => {
    onOpenInSidebar?.(node.uuid);
  };

  const handleCollapseClick = useCallback((e: React.MouseEvent) => {
    if (!onCollapseToggle) return;
    e.preventDefault();
    e.stopPropagation();
    onCollapseToggle();
  }, [onCollapseToggle]);

  const hasChildren = hasChildrenOverride ?? (node.has_children ?? false);
  const collapsed = collapsedProp ?? node.collapsed ?? false;

  return (
    <div className="block-ui">
      {hasChildren && onCollapseToggle && (
        <button
          className="block-collapse-arrow"
          onClick={handleCollapseClick}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          <span className="block-collapse-arrow__icon">{collapsed ? '\u25B8' : '\u25BE'}</span>
        </button>
      )}
      <Bullet
        nodeId={node.id}
        icon={iconOverride ?? node.icon}
        isPage={node.is_page}
        hasChildren={hasChildren}
        collapsed={collapsed}
        onClick={handleClick}
        onShiftClick={handleShiftClick}
        onContextMenu={onContextMenu}
        isHovered={isHovered}
        size="sm"
      />
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
