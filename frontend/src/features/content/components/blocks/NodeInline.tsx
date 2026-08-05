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
import type { Node } from '@/types';
import { nodeNameToText, nodeNameToDisplayText } from '@/features/queries';
import { useSettingsStore } from '@/stores';
import { Bullet } from './Bullet';
import { NodeIcon } from '@/components/ui/icons';
import './NodeInline.css';

export interface NodeInlineProps {
  /** Node object used for class-aware display (e.g. date formatting). */
  node?: Node | null;
  /** Node name (raw, may contain AST markup). Used as fallback when `node` is not provided. */
  name?: string | null;
  /** Icon emoji/path */
  icon?: string | null;
  /** Whether this is a page node */
  isPage?: boolean;
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
  /** Visual variant (e.g. group-link uses dotted underline). */
  variant?: 'default' | 'group-link';
}

/**
 * Simple inline node name renderer.
 * Use for read-only display of a node's name with optional icon/bullet.
 */
export function NodeInline({
      node,
      name,
      icon,
      isPage = false,
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
      variant = 'default' }: NodeInlineProps) {
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const displayText = providedDisplayText
    || propertyName
    || (node ? nodeNameToDisplayText(node, { dateFormat }) : nodeNameToText(name))
    || 'Untitled';

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && onShiftClick) {
      e.preventDefault();
      onShiftClick();
    } else if (onClick) {
      // Keep SPA navigation in the click handler; without this the browser
      // would follow the href and trigger a full page load.
      e.preventDefault();
      onClick();
    }
  }, [onClick, onShiftClick]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (nodeUuid) {
      e.dataTransfer.setData(
        'application/x-notees-node',
        JSON.stringify({ nodeUuid, name: providedDisplayText || displayText })
      );
      e.dataTransfer.effectAllowed = 'link';
    }
  }, [nodeUuid, providedDisplayText, displayText]);

  const href = onClick && nodeUuid ? `/node/${nodeUuid}` : undefined;
  // Clickable items render as a real link when a target URL exists, otherwise
  // as a button so they stay keyboard-focusable with the right semantics.
  const Tag = onClick ? (href ? 'a' : 'button') : 'span';

  return (
    <Tag
      className={`node-inline ${onClick ? 'node-inline--clickable' : ''} ${className}`}
      data-variant={variant}
      href={href}
      type={Tag === 'button' ? 'button' : undefined}
      onClick={onClick ? handleClick : undefined}
      draggable={draggable}
      onDragStart={handleDragStart}
      title={title ?? displayText}
    >
      {showBullet && (
        <Bullet
          nodeUuid={nodeUuid}
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
    </Tag>
  );
}

