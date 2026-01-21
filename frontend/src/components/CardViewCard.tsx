/**
 * CardViewCard Component
 * 
 * A card component for displaying blocks in card view mode.
 * Uses BlockContentPreview for consistent block display with sidebar.
 * Supports different layouts with cover images:
 * - no-cover: Card without cover image
 * - cover-top: Cover image on top of the card
 * - cover-side: Cover image on the left side of the card
 */
import { useMemo, useCallback } from 'react';
import type { Node } from '@/types';
import { BlockPreview } from './blocks/BlockPreview';
import './CardViewCard.css';

export type CardLayout = 'no-cover' | 'cover-top' | 'cover-side';

export interface CardViewCardProps {
  /** The block/node to display */
  node: Node;
  /** Card layout style */
  layout?: CardLayout;
  /** Cover image URL or asset UUID */
  cover?: string | null;
  /** Click handler */
  onClick?: () => void;
  /** Shift+click handler */
  onShiftClick?: () => void;
  /** Additional CSS class */
  className?: string;
}

/**
 * Extract the first image asset from node content
 */
function extractCoverImage(node: Node): string | null {
  if (!node.name) return null;
  
  // Match markdown image: ![alt](uuid or url)
  const imageMatch = node.name.match(/!\[.*?\]\(([^)]+)\)/);
  if (imageMatch) {
    return imageMatch[1];
  }
  
  return null;
}

export function CardViewCard({
  node,
  layout = 'cover-top',
  cover,
  onClick,
  onShiftClick,
  className = '',
}: CardViewCardProps) {
  // Extract cover from content if not provided
  const coverImage = useMemo(() => {
    if (cover !== undefined) return cover;
    return extractCoverImage(node);
  }, [cover, node]);
  
  // Determine effective layout based on cover availability
  const effectiveLayout = useMemo(() => {
    if (!coverImage) return 'no-cover';
    return layout;
  }, [coverImage, layout]);
  
  // Handle click with shift detection
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && onShiftClick) {
      e.preventDefault();
      onShiftClick();
    } else if (onClick) {
      onClick();
    }
  }, [onClick, onShiftClick]);
  
  // Resolve cover URL (could be asset UUID or direct URL)
  const coverUrl = useMemo(() => {
    if (!coverImage) return null;
    
    // If it's a UUID (no protocol), convert to asset URL
    if (!coverImage.includes('://') && !coverImage.startsWith('/')) {
      return `/api/assets/${coverImage}`;
    }
    
    return coverImage;
  }, [coverImage]);
  
  // Build style object for node color
  const cardStyle = useMemo(() => {
    if (!node.color) return undefined;
    return {
      '--card-color': node.color,
      borderLeftColor: node.color,
      borderLeftWidth: '3px',
    } as React.CSSProperties;
  }, [node.color]);
  
  return (
    <div
      className={`card-view-card card-view-card--${effectiveLayout} ${node.color ? 'card-view-card--has-color' : ''} ${className}`}
      onClick={handleClick}
      style={cardStyle}
    >
      {/* Cover image - only show for cover layouts */}
      {effectiveLayout !== 'no-cover' && coverUrl && (
        <div className="card-view-card__cover">
          <img 
            src={coverUrl} 
            alt="" 
            className="card-view-card__cover-img"
            loading="lazy"
          />
        </div>
      )}
      
      <div className="card-view-card__body">
        {/* Block content preview - same as sidebar */}
        <BlockPreview
          variant="card"
          node={node}
          showBullet={true}
          showIcon={false}
          maxLines={effectiveLayout === 'cover-side' ? 2 : 4}
          size="sm"
          className="card-view-card__content"
        />
      </div>
    </div>
  );
}

export default CardViewCard;
