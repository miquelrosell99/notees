/**
 * BlockUI — Non-editable chrome for a block row.
 *
 * Bullet, icon, collapse arrow, depth indentation.
 * This replaces the first half of BlockNode.createDOM.
 */

import { useCallback } from 'react';
import { Bullet } from './Bullet';
import { Icon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { useFocusMode } from '@/hooks';
import type { Node } from '@/types/api';
import type { JSX } from 'react';
import type { PresenceUser } from '@/features/collab';
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
  /** Whether the bullet should be interactive (clickable/draggable). */
  interactive?: boolean;
  /** Whether this block is on the active editing path. */
  isActivePath?: boolean;
  /** Nesting depth of the block (0 = top-level). */
  depth?: number;
  /** Remote users currently editing this block (for lock indicator). */
  lockedBy?: PresenceUser[];
  /** Remote users currently focused on this block (presence). */
  presenceUsers?: PresenceUser[];
  /** Remote users currently typing in this block (ephemeral). */
  typingUsers?: PresenceUser[];
  /** True when the local user is queued for this block's lock. */
  isQueued?: boolean;
  /** Active conflict info for the local user on this block. */
  conflict?: { reason: string; user?: PresenceUser } | null;
  /** Request to be added to the lock wait queue. */
  onRequestLock?: () => void;
  /** Dismiss the conflict banner and refresh the block. */
  onResolveConflict?: () => void;
  /** Whether the parent row is hovered (drives collapse-arrow reveal). */
  rowHover?: boolean;
  /** Whether this block is a ghost pseudo-block. */
  isGhost?: boolean;
  /** Compact list-view size context (e.g. 'sm' for small list view). */
  listSize?: 'sm' | 'md';
  /** Whether this block is rendered inside a property text block editor. */
  inPropertyEditor?: boolean;
  /** Document mode: hide bullets and flatten chrome. */
  documentMode?: boolean;
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
  interactive = true,
  isActivePath = false,
  depth = 0,
  lockedBy,
  presenceUsers,
  typingUsers,
  isQueued,
  conflict,
  onRequestLock,
  onResolveConflict,
  rowHover = false,
  isGhost = false,
  listSize,
  inPropertyEditor,
  documentMode,
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
  const ownerColor = lockedBy?.[0]?.color;
  const isFocusMode = useFocusMode();

  return (
    <div
      className="block-ui"
      data-owner-color={ownerColor || undefined}
      data-row-hover={rowHover || undefined}
      data-list-size={listSize || undefined}
      data-property-editor={inPropertyEditor || undefined}
      data-focus-mode={isFocusMode || undefined}
      data-document-mode={documentMode || undefined}
      style={ownerColor ? { '--block-owner-color': ownerColor } as React.CSSProperties : undefined}
    >
      {hasChildren && onCollapseToggle && (
        <button
          className={`block-collapse-arrow icon-only-touch-target ${(isActivePath && depth > 0) ? 'block-collapse-arrow--thread-overlap' : ''}`}
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
        interactive={interactive}
        hasChildren={hasChildren}
        collapsed={collapsed}
        onClick={handleClick}
        onShiftClick={handleShiftClick}
        onContextMenu={onContextMenu}
        isActivePath={isActivePath}
        showMiniBullet={isActivePath && !!(iconOverride ?? node.icon)}
        size="sm"
        disableOpticalOffset
        isGhost={isGhost}
        listSize={listSize}
        inPropertyEditor={inPropertyEditor}
        documentMode={documentMode}
        spacing="default"
        focusMode={isFocusMode}
      />
      {presenceUsers && presenceUsers.length > 0 && (
        <div className="block-ui__presence">
          {presenceUsers.map((u) => (
            <span
              key={u.id}
              className="block-ui__presence-avatar"
              title={`${u.name} is here`}
              style={{ backgroundColor: u.color || 'var(--color-on-surface-variant)' }}
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
              style={{ backgroundColor: u.color || 'var(--color-on-surface-variant)' }}
            />
          ))}
        </div>
      )}
      {isQueued && (
        <div className="block-ui__queue" title="Waiting to edit">
          <Icon path="mdi mdi-timer-sand" size={0.7} color="var(--color-outline)" />
        </div>
      )}
      {lockedBy && lockedBy.length > 0 && onRequestLock && !isQueued && (
        <button
          type="button"
          className="block-ui__request-button"
          onClick={(e) => {
            e.stopPropagation();
            onRequestLock();
          }}
          title="Request to edit"
          aria-label="Request to edit"
        >
          <Icon path="mdi mdi-pencil-lock" size={0.7} color="var(--color-outline)" />
        </button>
      )}
      {conflict && onResolveConflict && (
        <div className="block-ui__conflict">
          <span className="block-ui__conflict-text">
            {conflict.reason === 'lock_expired'
              ? 'Your lock expired.'
              : 'This block was edited by someone else.'}
          </span>
          <Button variant="primary" size="sm" onClick={onResolveConflict}>
            Refresh
          </Button>
        </div>
      )}
    </div>
  );
}
