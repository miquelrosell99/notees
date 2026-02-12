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
import { NodeIcon } from '../core/icons';
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
  showBullet = false,
  showIcon = false,
  onClick,
  onShiftClick,
  className = '',
  propertyName,
  suppressColor: _suppressColor = false,
}: NodeInlineProps) {
  const displayText = propertyName || nodeNameToText(name) || 'Untitled';

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && onShiftClick) {
      e.preventDefault();
      onShiftClick();
    } else if (onClick) {
      onClick();
    }
  }, [onClick, onShiftClick]);

  return (
    <span
      className={`node-inline ${onClick ? 'node-inline--clickable' : ''} ${className}`}
      onClick={handleClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
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

export default NodeInline;
