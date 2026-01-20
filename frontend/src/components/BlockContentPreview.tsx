/**
 * BlockContentPreview Component
 * 
 * A minified, read-only view of a block's content.
 * Used in card views, sidebar previews, and anywhere a compact block display is needed.
 * 
 * Features:
 * - Renders content with links as clickable pills (via ContentWithPills)
 * - Optional bullet point
 * - Optional icon
 * - Consistent styling with the Block component
 * - Supports click and shift+click handlers
 */
import { useMemo, useCallback } from 'react';
import type { Node } from '@/types';
import { ContentWithPills } from './ContentWithPills';
import { Bullet } from './Bullet';
import { NodeIcon } from './icons';
import './BlockContentPreview.css';

export interface BlockContentPreviewProps {
  /** The node/block to display */
  node: Node;
  /** Whether to show the bullet */
  showBullet?: boolean;
  /** Whether to show the icon (emoji/node icon) */
  showIcon?: boolean;
  /** Maximum number of lines to show (0 for unlimited) */
  maxLines?: number;
  /** Click handler for the content */
  onClick?: () => void;
  /** Shift+click handler */
  onShiftClick?: () => void;
  /** Bullet click handler */
  onBulletClick?: () => void;
  /** Additional CSS class */
  className?: string;
  /** Size variant */
  size?: 'sm' | 'md';
}

export function BlockContentPreview({
  node,
  showBullet = true,
  showIcon = false,
  maxLines = 3,
  onClick,
  onShiftClick,
  onBulletClick,
  className = '',
  size = 'md',
}: BlockContentPreviewProps) {
  // Handle click with shift detection
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && onShiftClick) {
      e.preventDefault();
      onShiftClick();
    } else if (onClick) {
      onClick();
    }
  }, [onClick, onShiftClick]);

  // Handle bullet click
  const handleBulletClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey && onShiftClick) {
      onShiftClick();
    } else if (onBulletClick) {
      onBulletClick();
    } else if (onClick) {
      onClick();
    }
  }, [onBulletClick, onShiftClick, onClick]);

  // Determine if block has children
  const hasChildren = node.children && node.children.length > 0;

  // Line clamp style
  const contentStyle = useMemo(() => {
    if (maxLines > 0) {
      return {
        WebkitLineClamp: maxLines,
        lineClamp: maxLines,
      } as React.CSSProperties;
    }
    return undefined;
  }, [maxLines]);

  const content = node.name || '';

  return (
    <div 
      className={`block-content-preview block-content-preview--${size} ${className}`}
      onClick={handleClick}
    >
      {showBullet && (
        <div className="block-content-preview__bullet" onClick={handleBulletClick}>
          <Bullet
            nodeId={node.id}
            icon={node.icon}
            hasChildren={hasChildren}
            collapsed={false}
            interactive={false}
          />
        </div>
      )}
      
      {showIcon && (node.icon || node.is_page) && (
        <NodeIcon
          icon={node.icon}
          isPage={node.is_page}
          isDaily={node.is_daily}
          isMonthly={node.is_monthly}
          isYearly={node.is_yearly}
          size="sm"
          className="block-content-preview__icon"
        />
      )}
      
      <div 
        className={`block-content-preview__content ${maxLines > 0 ? 'block-content-preview__content--clamped' : ''}`}
        style={contentStyle}
      >
        {content ? (
          <ContentWithPills
            content={content}
            blockId={node.id}
            className="block-content-preview__pills"
          />
        ) : (
          <span className="block-content-preview__empty">Empty</span>
        )}
      </div>
      
      {/* Metadata badges */}
      <div className="block-content-preview__badges">
        {hasChildren && (
          <span className="block-content-preview__badge block-content-preview__badge--children">
            {node.children!.length}
          </span>
        )}
        {node.comment_count !== undefined && node.comment_count > 0 && (
          <span className="block-content-preview__badge block-content-preview__badge--comments">
            💬 {node.comment_count}
          </span>
        )}
      </div>
    </div>
  );
}

export default BlockContentPreview;
