/**
 * BlockPreview Component
 * 
 * A unified read-only preview component for block content.
 * Consolidates BlockDisplay and BlockContentPreview into a single component
 * with variant support.
 * 
 * Part of the Block hierarchy:
 * Block
 *  ├─ BlockContainer
 *  ├─ BlockBullet
 *  ├─ BlockContent / BlockEditor
 *  └─ BlockChildren
 * 
 * BlockPreview (this component) - read-only preview, separate from editable Block
 * 
 * Variants:
 * - 'simple': Minimal preview (replaces BlockDisplay)
 * - 'card': Rich preview with badges, line clamping (replaces BlockContentPreview)
 * 
 * Features:
 * - Renders content with [[linkId]] links as clickable pills
 * - Optional bullet/icon display
 * - Click and shift+click handlers
 * - Comment count badge
 * - Children count badge (card variant)
 * - Line clamping support (card variant)
 * - Size variants (card variant)
 */
import { useMemo, useCallback } from 'react';
import type { Node } from '@/types';
import { BlockContent } from './BlockContent';
import { Bullet } from './Bullet';
import { NodeIcon } from '../icons';
import './BlockPreview.css';

// ============== Types ==============

export type BlockPreviewVariant = 'simple' | 'card';
export type BlockPreviewSize = 'sm' | 'md';

export interface BlockPreviewProps {
  /** Variant: 'simple' for minimal, 'card' for rich preview */
  variant?: BlockPreviewVariant;
  
  // Content source (one of these should be provided)
  /** Full node object (preferred for 'card' variant) */
  node?: Node;
  /** Direct content string (alternative to node, for 'simple' variant) */
  content?: string;
  /** Block ID for link click tracking */
  blockId?: number;
  
  // Display options
  /** Whether to show bullet point (default: true) */
  showBullet?: boolean;
  /** Whether to show the icon for pages (card variant) */
  showIcon?: boolean;
  /** Icon override (simple variant) */
  icon?: string | null;
  /** Maximum lines before clamping (0 = unlimited, card variant) */
  maxLines?: number;
  /** Size variant (card variant) */
  size?: BlockPreviewSize;
  /** Show placeholder text for empty blocks */
  showEmptyPlaceholder?: boolean;
  /** Property name to display (for breadcrumbs context) */
  propertyName?: string;
  
  // Event handlers
  /** Click handler */
  onClick?: () => void;
  /** Shift+click handler */
  onShiftClick?: () => void;
  /** Bullet click handler */
  onBulletClick?: () => void;
  
  /** Additional CSS class */
  className?: string;
}

// ============== Component ==============

export function BlockPreview({
  variant = 'simple',
  node,
  content: contentProp,
  blockId: blockIdProp,
  showBullet = true,
  showIcon = false,
  icon,
  maxLines = 0,
  size = 'md',
  showEmptyPlaceholder = false,
  propertyName,
  onClick,
  onShiftClick,
  onBulletClick,
  className = '',
}: BlockPreviewProps) {
  // Derive content and blockId from node or props
  const content = node?.name ?? contentProp ?? '';
  const blockId = node?.id ?? blockIdProp;
  const isEmpty = !content || content.trim() === '';
  
  // For card variant with node
  const hasChildren = node?.children && node.children.length > 0;
  const commentCount = node?.comment_count ?? 0;
  
  // Handle click with shift detection
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
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

  // Line clamp style for card variant
  const contentStyle = useMemo(() => {
    if (variant === 'card' && maxLines > 0) {
      return {
        WebkitLineClamp: maxLines,
        lineClamp: maxLines,
      } as React.CSSProperties;
    }
    return undefined;
  }, [variant, maxLines]);

  // Build class names
  const rootClassName = useMemo(() => {
    const classes = ['block-preview', `block-preview--${variant}`];
    if (variant === 'card') {
      classes.push(`block-preview--${size}`);
    }
    if (className) {
      classes.push(className);
    }
    return classes.join(' ');
  }, [variant, size, className]);

  // ============== Render ==============

  return (
    <div className={rootClassName} onClick={handleClick}>
      {/* Bullet */}
      {showBullet && (
        <div 
          className="block-preview__bullet"
          onClick={onBulletClick || onShiftClick ? handleBulletClick : undefined}
        >
          {variant === 'card' && node ? (
            <Bullet
              nodeId={node.id}
              icon={node.icon}
              hasChildren={hasChildren}
              collapsed={false}
              interactive={false}
            />
          ) : (
            icon ? (
              <NodeIcon icon={icon} isPage={false} size="xs" />
            ) : (
              <span className="block-preview__bullet-dot">•</span>
            )
          )}
        </div>
      )}
      
      {/* Property name (for breadcrumbs) */}
      {propertyName && (
        <span className="block-preview__property-name">{propertyName}</span>
      )}
      
      {/* Icon (card variant with showIcon) */}
      {variant === 'card' && showIcon && node && (node.icon || node.is_page) && (
        <NodeIcon
          icon={node.icon}
          isPage={node.is_page}
          isDaily={node.is_daily}
          isMonthly={node.is_monthly}
          isYearly={node.is_yearly}
          size="sm"
          className="block-preview__icon"
        />
      )}
      
      {/* Content */}
      <div 
        className={`block-preview__content${isEmpty ? ' block-preview__content--empty' : ''}${variant === 'card' && maxLines > 0 ? ' block-preview__content--clamped' : ''}`}
        style={contentStyle}
      >
        {isEmpty ? (
          showEmptyPlaceholder ? (
            <span className="block-preview__placeholder">
              {variant === 'card' ? 'Empty' : 'Empty block'}
            </span>
          ) : (
            <span className="block-preview__empty">&nbsp;</span>
          )
        ) : (
          <BlockContent
            content={content}
            blockId={blockId}
            className="block-preview__pills"
          />
        )}
      </div>
      
      {/* Badges */}
      {(commentCount > 0 || (variant === 'card' && hasChildren)) && (
        <div className="block-preview__badges">
          {variant === 'card' && hasChildren && (
            <span className="block-preview__badge block-preview__badge--children">
              {node!.children!.length}
            </span>
          )}
          {commentCount > 0 && (
            <span 
              className="block-preview__badge block-preview__badge--comments"
              title={`${commentCount} comment${commentCount > 1 ? 's' : ''}`}
            >
              💬 {commentCount}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default BlockPreview;
