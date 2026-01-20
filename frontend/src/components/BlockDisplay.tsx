/**
 * BlockDisplay Component
 * 
 * A read-only display component for block content with link pills.
 * Used for non-editing contexts like previews, backlinks, and simplified views.
 * 
 * Features:
 * - Renders content with [[linkId]] links as clickable pills
 * - Optional bullet display
 * - Click handler for entering edit mode or navigation
 * - Comment count badge
 * - Lightweight compared to full Block/BlockEditor
 */
import { useCallback } from 'react';
import { ContentWithPills } from './ContentWithPills';
import { NodeIcon } from './icons';
import './BlockDisplay.css';

interface BlockDisplayProps {
  /** Block ID for identification */
  blockId?: number;
  /** Content to display (may contain [[linkId]] markers) */
  content: string;
  /** Icon to display instead of bullet */
  icon?: string | null;
  /** Whether to show bullet point */
  showBullet?: boolean;
  /** Comment count to show badge */
  commentCount?: number;
  /** Called when block content area is clicked */
  onClick?: () => void;
  /** Called when bullet is clicked (for navigation) */
  onBulletClick?: () => void;
  /** Custom class name */
  className?: string;
  /** Whether to show as empty placeholder style */
  showEmptyPlaceholder?: boolean;
}

export function BlockDisplay({
  blockId,
  content,
  icon,
  showBullet = true,
  commentCount = 0,
  onClick,
  onBulletClick,
  className = '',
  showEmptyPlaceholder = false,
}: BlockDisplayProps) {
  
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClick?.();
  }, [onClick]);

  const handleBulletClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onBulletClick?.();
  }, [onBulletClick]);

  const isEmpty = !content || content.trim() === '';

  return (
    <div 
      className={`block-display ${className}`.trim()}
      onClick={handleClick}
    >
      {showBullet && (
        <span 
          className="block-display-bullet" 
          onClick={onBulletClick ? handleBulletClick : undefined}
        >
          {icon ? (
            <NodeIcon icon={icon} isPage={false} size="xs" className="block-icon" />
          ) : (
            '•'
          )}
        </span>
      )}
      
      <div className={`block-display-content${isEmpty ? ' block-display-content--empty' : ''}`}>
        {isEmpty ? (
          showEmptyPlaceholder ? (
            <span className="block-display-placeholder">Empty block</span>
          ) : (
            <span className="block-display-empty">&nbsp;</span>
          )
        ) : (
          <ContentWithPills
            content={content}
            blockId={blockId}
            className="block-display-pills"
          />
        )}
      </div>
      
      {commentCount > 0 && (
        <span className="block-display-comment-badge" title={`${commentCount} comment${commentCount > 1 ? 's' : ''}`}>
          💬 {commentCount}
        </span>
      )}
    </div>
  );
}

export default BlockDisplay;
