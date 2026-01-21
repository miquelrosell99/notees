/**
 * NodeCardView Component
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
 * - Context menu on right-click
 * - Selection checkbox on hover
 */
import { useCallback, useState, useRef, useEffect } from 'react';
import type { NodeCardViewProps } from '@/types/nodeCollection';
import { useTypes } from '@/hooks';
import { NodeCard } from './NodeCard';
import './NodeCardView.css';

/**
 * NodeCardView - Card grid view for NodeCollection
 */
export function NodeCardView({
  nodes,
  depth = 0,
  maxDepth = 2,
  layout = 'cover-top',
  columns,
  sortable,
  editable = true,
  selectable = false,
  selectedIds: controlledSelectedIds,
  onSelectionChange: controlledOnSelectionChange,
  onReorder,
  onNodeClick,
  onNodeShiftClick,
  onContentChange,
  className = '',
}: NodeCardViewProps) {
  const gridStyle = columns ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined;
  
  // Fetch all types for icon inheritance
  const { data: allTypes } = useTypes();
  
  // Internal selection state when selectable but not controlled
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<number>>(new Set());
  
  // Use controlled or internal selection (only when selectable)
  const selectedIds = selectable ? (controlledSelectedIds ?? internalSelectedIds) : undefined;
  const onSelectionChange = selectable ? (controlledOnSelectionChange ?? setInternalSelectedIds) : undefined;
  
  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Handle selection change for individual card
  const handleCardSelectionChange = useCallback((nodeId: number, selected: boolean) => {
    if (!onSelectionChange) return;
    const newSelectedIds = new Set(selectedIds || []);
    if (selected) {
      newSelectedIds.add(nodeId);
    } else {
      newSelectedIds.delete(nodeId);
    }
    onSelectionChange(newSelectedIds);
  }, [selectedIds, onSelectionChange]);
  
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
    'node-card-view',
    sortable && 'node-card-view--sortable',
    selectable && 'node-card-view--selectable',
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
          isSelected={selectable && selectedIds?.has(node.id)}
          onNodeClick={onNodeClick}
          onNodeShiftClick={onNodeShiftClick}
          onContentChange={onContentChange}
          onDragStart={handleDragStart}
          onSelectionChange={selectable ? handleCardSelectionChange : undefined}
        />
      ))}
    </div>
  );
}
