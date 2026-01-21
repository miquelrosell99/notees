/**
 * NodeCardGrid Component
 * 
 * Card grid view for NodeCollection.
 * Displays nodes as cards in a responsive grid layout.
 * 
 * Features:
 * - Responsive grid layout
 * - Card with title and content preview
 * - Optional cover images
 * - Recursive children shown inside card body
 * - Editable: allows interaction and navigation
 * - Read-only: display-only cards
 */
import { useCallback, useMemo } from 'react';
import type { Node } from '@/types';
import type { NodeCardViewProps } from '@/types/nodeCollection';
import { BlockPreview } from '../../blocks/BlockPreview';
import { NodeIcon } from '../../icons';
import './NodeCardGrid.css';

interface NodeCardProps {
  node: Node;
  maxDepth: number;
  depth: number;
  layout: 'no-cover' | 'cover-top' | 'cover-side';
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
}

/**
 * Extract cover image from node content
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

/**
 * Resolve cover URL
 */
function resolveCoverUrl(coverImage: string | null): string | null {
  if (!coverImage) return null;
  
  // If it's a UUID (no protocol), convert to asset URL
  if (!coverImage.includes('://') && !coverImage.startsWith('/')) {
    return `/api/assets/${coverImage}`;
  }
  
  return coverImage;
}

function NodeCard({
  node,
  maxDepth,
  depth,
  layout,
  onNodeClick,
  onNodeShiftClick,
}: NodeCardProps) {
  const children = node.children ?? [];
  const shouldRenderChildren = depth < maxDepth && children.length > 0;
  
  // Extract cover from content
  const coverImage = useMemo(() => extractCoverImage(node), [node]);
  const coverUrl = useMemo(() => resolveCoverUrl(coverImage), [coverImage]);
  
  // Determine effective layout based on cover availability
  const effectiveLayout = coverUrl ? layout : 'no-cover';
  
  // Handle click
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.shiftKey && onNodeShiftClick) {
      e.preventDefault();
      onNodeShiftClick(node);
    } else if (onNodeClick) {
      onNodeClick(node);
    }
  }, [node, onNodeClick, onNodeShiftClick]);
  
  // Card style based on node color
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
      className={`node-card node-card--${effectiveLayout}`}
      style={cardStyle}
      onClick={handleClick}
    >
      {/* Cover image */}
      {coverUrl && (
        <div className="node-card__cover">
          <img src={coverUrl} alt="" className="node-card__cover-image" />
        </div>
      )}
      
      {/* Card content */}
      <div className="node-card__body">
        {/* Title */}
        <div className="node-card__header">
          <NodeIcon icon={node.icon} isPage={node.is_page} size="sm" />
          <h3 className="node-card__title">{node.name || 'Untitled'}</h3>
        </div>
        
        {/* Children preview */}
        {shouldRenderChildren && (
          <div className="node-card__children">
            {children.slice(0, 3).map((child) => (
              <BlockPreview
                key={child.id}
                variant="card"
                node={child}
                showBullet={true}
                maxLines={2}
                size="sm"
                onClick={() => onNodeClick?.(child)}
                onShiftClick={() => onNodeShiftClick?.(child)}
              />
            ))}
            {children.length > 3 && (
              <div className="node-card__more">
                +{children.length - 3} more
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * NodeCardGrid - Card grid view for NodeCollection
 */
export function NodeCardGrid({
  nodes,
  depth = 0,
  maxDepth = 2,
  layout = 'cover-top',
  columns,
  onNodeClick,
  onNodeShiftClick,
  className = '',
}: NodeCardViewProps) {
  const gridStyle = columns ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined;

  return (
    <div className={`node-card-grid ${className}`} style={gridStyle}>
      {nodes.map((node) => (
        <NodeCard
          key={node.id}
          node={node}
          maxDepth={maxDepth}
          depth={depth}
          layout={layout}
          onNodeClick={onNodeClick}
          onNodeShiftClick={onNodeShiftClick}
        />
      ))}
    </div>
  );
}
