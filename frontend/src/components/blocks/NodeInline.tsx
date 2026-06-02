/**
 * NodeInline Component
 * 
 * Lightweight inline display of a node's name with optional icon.
 * Replaces BlockPreview for simple text display cases (breadcrumbs, 
 * activity log, navigation sidebar, group headers, property labels, etc.)
 * 
 * No editing, no stores, no legacy code.
 */
import { useCallback } from 'react';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { Bullet } from './Bullet';
import { NodeIcon } from '@/components/core/icons';
import './NodeInline.css';

export interface NodeInlineProps {
  /** Node name (raw, may contain AST markup) */
  name?: string | null;
  /** Icon emoji/path */
  icon?: string | null;
  /** Whether this is a page node */
  isPage?: boolean;
  /** Node ID (for bullet) */
  nodeId?: number;
  /** Node UUID (for drag-and-drop) */
  nodeUuid?: string;
  /** Show a bullet/icon on the left */
  showBullet?: boolean;
  /** Show the node icon (alternative to bullet) */
  showIcon?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Shift+click handler */
  onShiftClick?: () => void;
  /** Additional CSS class */
  className?: string;
  /** Property name display (used in breadcrumbs) */
  propertyName?: string;
  /** Suppress node color */
  suppressColor?: boolean;
  /** Pre-resolved display text (bypasses nodeNameToText, used when links need resolution) */
  displayText?: string;
  /** Tooltip title text (shown on hover) */
  title?: string;
  /** Make the element draggable */
  draggable?: boolean;
}

/**
 * Simple inline node name renderer.
 * Use for read-only display of a node's name with optional icon/bullet.
 */
export function NodeInline({
  name,
  icon,
  isPage = false,
  nodeId,
  nodeUuid,
  showBullet = false,
  showIcon = false,
  onClick,
  onShiftClick,
  className = '',
  propertyName,
  displayText: providedDisplayText,
  title,
  draggable = false,
}: NodeInlineProps) {
  const displayText = providedDisplayText || propertyName || nodeNameToText(name) || 'Untitled';

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && onShiftClick) {
      e.preventDefault();
      onShiftClick();
    } else if (onClick) {
      onClick();
    }
  }, [onClick, onShiftClick]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (nodeUuid) {
      e.dataTransfer.setData(
        'application/x-notees-node',
        JSON.stringify({ nodeId, nodeUuid, name: providedDisplayText || displayText })
      );
      e.dataTransfer.effectAllowed = 'link';
    }
  }, [nodeUuid, nodeId, providedDisplayText, displayText]);

  return (
    <span role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
      className={`node-inline ${onClick ? 'node-inline--clickable' : ''} ${className}`}
      onClick={handleClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      draggable={draggable}
      onDragStart={handleDragStart}
      title={title ?? displayText}
    >
      {showBullet && (
        <Bullet
          nodeId={nodeId}
          icon={icon}
          isPage={isPage}
          interactive={false}
          size="sm"
        />
      )}
      {showIcon && !showBullet && icon && (
        <NodeIcon icon={icon} isPage={isPage} size="sm" />
      )}
      <span className="node-inline__text">{displayText}</span>
    </span>
  );
}

