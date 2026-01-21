/**
 * NodeCardGrid Component
 * 
 * Card grid view for NodeCollection.
 * Displays nodes as cards in a responsive grid layout.
 * 
 * Features:
 * - Responsive grid layout
 * - Card with header section (Block-based title like sidebar)
 * - Optional cover images
 * - Children shown via nested NodeCollection in list view
 * - Editable: allows interaction and navigation
 * - Read-only: display-only cards
 * - Optional drag-and-drop reordering
 */
import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import type { Node } from '@/types';
import type { NodeCardViewProps } from '@/types/nodeCollection';
import { useTypes } from '@/hooks';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { BlockPreview } from '../../blocks/BlockPreview';
import { NodeCollection } from '../NodeCollection';
import { DragHandleIcon } from '../../icons';
import { Card } from '../../core/Card';
import './NodeCardGrid.css';

interface NodeCardProps {
  node: Node;
  index: number;
  maxDepth: number;
  depth: number;
  layout: 'no-cover' | 'cover-top' | 'cover-side';
  sortable?: boolean;
  isDragging?: boolean;
  isDropTarget?: boolean;
  editable?: boolean;
  allTypes?: Node[];
  onNodeClick?: (node: Node) => void;
  onNodeShiftClick?: (node: Node) => void;
  onContentChange?: (nodeId: number, content: string) => void;
  onDragStart?: (index: number) => void;
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
  index,
  maxDepth,
  depth,
  layout,
  sortable,
  isDragging,
  isDropTarget,
  editable = true,
  allTypes,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  onDragStart,
}: NodeCardProps) {
  const children = node.children ?? [];
  const shouldRenderChildren = depth < maxDepth && children.length > 0;
  
  // Get effective icon (from node or inherited from type)
  const effectiveIcon = useMemo(() => getEffectiveIcon(node, allTypes), [node, allTypes]);
  
  // Determine if we should show the bullet in the header
  // Show bullet only if there's an effective icon (from node or type)
  const showBullet = !!effectiveIcon;
  
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

  // Handle drag start
  const handleDragHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDragStart?.(index);
  }, [index, onDragStart]);
  
  // Card style based on node color
  const cardStyle = useMemo(() => {
    if (!node.color) return undefined;
    return {
      '--card-color': node.color,
      borderLeftColor: node.color,
      borderLeftWidth: '3px',
    } as React.CSSProperties;
  }, [node.color]);

  const cardClassName = [
    'node-card',
    `node-card--${effectiveLayout}`,
    isDragging && 'node-card--dragging',
    isDropTarget && 'node-card--drop-target',
  ].filter(Boolean).join(' ');

  return (
    <Card 
      className={cardClassName}
      style={cardStyle}
      onClick={handleClick}
      padding={false}
      elevation="none"
      variant="default"
    >
      {/* Drag handle */}
      {sortable && (
        <button
          className="node-card__drag-handle"
          onMouseDown={handleDragHandleMouseDown}
          aria-label="Drag to reorder"
        >
          <DragHandleIcon size="sm" />
        </button>
      )}
      
      {/* Cover image */}
      {coverUrl && (
        <div className="node-card__cover">
          <img src={coverUrl} alt="" className="node-card__cover-image" />
        </div>
      )}
      
      {/* Card header - similar to sidebar cards */}
      <div className="node-card__header">
        <BlockPreview
          variant="simple"
          node={node}
          showBullet={showBullet}
          showIcon={true}
          icon={effectiveIcon}
          onClick={() => onNodeClick?.(node)}
          onShiftClick={() => onNodeShiftClick?.(node)}
          className="node-card__title-block"
        />
      </div>
      
      {/* Card body with children */}
      {shouldRenderChildren && (
        <div className="node-card__body">
          <NodeCollection
            nodes={children}
            viewMode="list"
            availableViewModes={['list']}
            editable={editable}
            sortable={false}
            maxDepth={maxDepth - depth - 1}
            onNodeClick={onNodeClick}
            onNodeShiftClick={onNodeShiftClick}
            onContentChange={onContentChange}
            showEmpty={false}
            className="node-card__children"
          />
        </div>
      )}
    </Card>
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
  sortable,
  editable = true,
  onReorder,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  className = '',
}: NodeCardViewProps) {
  const gridStyle = columns ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined;
  
  // Fetch all types for icon inheritance
  const { data: allTypes } = useTypes();
  
  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Handle drag start
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);
  
  // Handle mouse move during drag
  useEffect(() => {
    if (dragIndex === null || !sortable) return;
    
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      
      const cards = containerRef.current.querySelectorAll('.node-card');
      let newDropTarget: number | null = null;
      
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        // Check if mouse is within the card bounds
        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          // Determine if dropping before or after based on position
          if (e.clientX < centerX || e.clientY < centerY) {
            newDropTarget = i;
          } else {
            newDropTarget = i;
          }
          break;
        }
      }
      
      setDropTargetIndex(newDropTarget);
    };
    
    const handleMouseUp = () => {
      if (dragIndex !== null && dropTargetIndex !== null && dragIndex !== dropTargetIndex) {
        onReorder?.(dragIndex, dropTargetIndex);
      }
      setDragIndex(null);
      setDropTargetIndex(null);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragIndex, dropTargetIndex, sortable, onReorder]);
  
  const gridClassName = [
    'node-card-grid',
    sortable && 'node-card-grid--sortable',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={gridClassName} style={gridStyle} ref={containerRef}>
      {nodes.map((node, index) => (
        <NodeCard
          key={node.id}
          node={node}
          index={index}
          maxDepth={maxDepth}
          depth={depth}
          layout={layout}
          sortable={sortable}
          isDragging={dragIndex === index}
          isDropTarget={dropTargetIndex === index && dragIndex !== index}
          editable={editable}
          allTypes={allTypes}
          onNodeClick={onNodeClick}
          onNodeShiftClick={onNodeShiftClick}
          onContentChange={onContentChange}
          onDragStart={handleDragStart}
        />
      ))}
    </div>
  );
}
