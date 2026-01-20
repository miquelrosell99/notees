/**
 * ReorderableList Component
 * 
 * A reusable list component with animated drag-and-drop reordering.
 * Uses standard drag-and-drop patterns with smooth auto-scrolling.
 */
import { useRef, useState, useCallback, useEffect } from 'react';
import { mdiClose } from '@mdi/js';
import { Button } from './Button';
import './ReorderableList.css';

export interface ReorderableItem {
  id: string | number;
}

export interface ReorderableListProps<T extends ReorderableItem> {
  items: T[];
  onReorder: (fromIndex: number, toIndex: number) => void;
  renderItem: (item: T, index: number) => React.ReactNode;
  onRemove?: (item: T, index: number) => void;
  className?: string;
  itemClassName?: string;
  showDragHandle?: boolean;
  showRemoveButton?: boolean;
  dragHandleContent?: React.ReactNode;
  removeButtonContent?: React.ReactNode;
}

interface DragState {
  dragIndex: number;
  targetIndex: number;
  // Mouse position relative to container's scrollable content
  mouseYInContent: number;
  // Offset from mouse to top edge of dragged item
  grabOffset: number;
}

export function ReorderableList<T extends ReorderableItem>({
  items,
  onReorder,
  renderItem,
  onRemove,
  className = '',
  itemClassName = '',
  showDragHandle = true,
  showRemoveButton = false,
  dragHandleContent,
  removeButtonContent,
}: ReorderableListProps<T>) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [isSettling, setIsSettling] = useState(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const itemHeightRef = useRef(40);
  const scrollRAF = useRef<number | null>(null);
  const lastClientY = useRef(0);

  // Measure item height
  useEffect(() => {
    if (containerRef.current) {
      const firstItem = containerRef.current.querySelector('.reorderable-list__item') as HTMLElement;
      if (firstItem) {
        itemHeightRef.current = firstItem.offsetHeight;
      }
    }
  }, [items.length]);

  // Handle drag start
  const handleDragStart = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    // Measure item height
    const firstItem = container.querySelector('.reorderable-list__item') as HTMLElement;
    if (firstItem) {
      itemHeightRef.current = firstItem.offsetHeight;
    }

    const containerRect = container.getBoundingClientRect();
    const itemTop = index * itemHeightRef.current;
    
    // Where in the content the mouse is (accounting for scroll)
    const mouseYInContent = e.clientY - containerRect.top + container.scrollTop;
    // How far from the top of the item the user grabbed
    const grabOffset = mouseYInContent - itemTop;

    lastClientY.current = e.clientY;

    setDragState({
      dragIndex: index,
      targetIndex: index,
      mouseYInContent,
      grabOffset,
    });
  }, []);

  // Main drag effect
  useEffect(() => {
    if (!dragState) return;

    const container = containerRef.current;
    if (!container) return;

    const updateDragPosition = (clientY: number) => {
      const containerRect = container.getBoundingClientRect();
      const mouseYInContent = clientY - containerRect.top + container.scrollTop;
      
      // Calculate target index based on where the item would be dropped
      const itemHeight = itemHeightRef.current;
      const draggedItemTop = mouseYInContent - dragState.grabOffset;
      const draggedItemCenter = draggedItemTop + itemHeight / 2;
      const rawTarget = Math.floor(draggedItemCenter / itemHeight);
      const targetIndex = Math.max(0, Math.min(items.length - 1, rawTarget));

      setDragState(prev => prev ? {
        ...prev,
        mouseYInContent,
        targetIndex,
      } : null);

      return { containerRect, mouseYInContent };
    };

    const handleMouseMove = (e: MouseEvent) => {
      lastClientY.current = e.clientY;
      const { containerRect } = updateDragPosition(e.clientY);

      // Handle auto-scroll
      const scrollZone = 40;
      const maxSpeed = 6;
      
      const distFromTop = e.clientY - containerRect.top;
      const distFromBottom = containerRect.bottom - e.clientY;
      
      // Cancel existing scroll animation
      if (scrollRAF.current) {
        cancelAnimationFrame(scrollRAF.current);
        scrollRAF.current = null;
      }

      const canScrollUp = container.scrollTop > 0;
      const canScrollDown = container.scrollTop < container.scrollHeight - container.clientHeight;

      if (distFromTop < scrollZone && canScrollUp) {
        const speed = Math.ceil(((scrollZone - distFromTop) / scrollZone) * maxSpeed);
        
        const doScroll = () => {
          if (container.scrollTop > 0) {
            container.scrollTop -= speed;
            updateDragPosition(lastClientY.current);
            scrollRAF.current = requestAnimationFrame(doScroll);
          }
        };
        scrollRAF.current = requestAnimationFrame(doScroll);
        
      } else if (distFromBottom < scrollZone && canScrollDown) {
        const speed = Math.ceil(((scrollZone - distFromBottom) / scrollZone) * maxSpeed);
        
        const doScroll = () => {
          if (container.scrollTop < container.scrollHeight - container.clientHeight) {
            container.scrollTop += speed;
            updateDragPosition(lastClientY.current);
            scrollRAF.current = requestAnimationFrame(doScroll);
          }
        };
        scrollRAF.current = requestAnimationFrame(doScroll);
      }
    };

    const handleMouseUp = () => {
      // Stop scrolling
      if (scrollRAF.current) {
        cancelAnimationFrame(scrollRAF.current);
        scrollRAF.current = null;
      }

      const { dragIndex, targetIndex } = dragState;
      
      // Disable transitions during settling
      setIsSettling(true);
      setDragState(null);
      
      // Reorder if position changed
      if (dragIndex !== targetIndex) {
        onReorder(dragIndex, targetIndex);
      }
      
      // Re-enable transitions after DOM settles
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsSettling(false);
        });
      });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (scrollRAF.current) {
        cancelAnimationFrame(scrollRAF.current);
        scrollRAF.current = null;
      }
    };
  }, [dragState, items.length, onReorder]);

  // Get transform style for each item
  const getItemStyle = (index: number): React.CSSProperties => {
    if (!dragState) return {};

    const { dragIndex, targetIndex, mouseYInContent, grabOffset } = dragState;
    const itemHeight = itemHeightRef.current;

    if (index === dragIndex) {
      // Dragged item: position based on mouse
      const naturalTop = dragIndex * itemHeight;
      const desiredTop = mouseYInContent - grabOffset;
      
      // Clamp to list bounds
      const minTop = 0;
      const maxTop = (items.length - 1) * itemHeight;
      const clampedTop = Math.max(minTop, Math.min(maxTop, desiredTop));
      
      const translateY = clampedTop - naturalTop;
      
      return {
        transform: `translateY(${translateY}px)`,
        zIndex: 100,
        transition: 'none',
      };
    }

    // Other items: shift to make room for dragged item
    let shift = 0;
    
    if (dragIndex < targetIndex) {
      // Dragging down: items between drag and target shift up
      if (index > dragIndex && index <= targetIndex) {
        shift = -itemHeight;
      }
    } else if (dragIndex > targetIndex) {
      // Dragging up: items between target and drag shift down
      if (index >= targetIndex && index < dragIndex) {
        shift = itemHeight;
      }
    }

    return {
      transform: shift !== 0 ? `translateY(${shift}px)` : undefined,
      zIndex: 1,
      transition: isSettling ? 'none' : 'transform 150ms ease-out',
    };
  };

  if (items.length === 0) {
    return null;
  }

  return (
    <div 
      ref={containerRef}
      className={`reorderable-list ${className} ${dragState ? 'reorderable-list--dragging' : ''}`}
    >
      {items.map((item, index) => {
        const isDragging = dragState?.dragIndex === index;
        const style = getItemStyle(index);
        
        return (
          <div
            key={item.id}
            className={`reorderable-list__item ${itemClassName} ${isDragging ? 'reorderable-list__item--dragging' : ''} ${isSettling ? 'reorderable-list__item--settling' : ''}`}
            style={style}
          >
            {showDragHandle && (
              <span 
                className="reorderable-list__drag-handle"
                onMouseDown={(e) => handleDragStart(index, e)}
              >
                {dragHandleContent || '⋮⋮'}
              </span>
            )}
            
            <div className="reorderable-list__content">
              {renderItem(item, index)}
            </div>
            
            {showRemoveButton && onRemove && (
              removeButtonContent ? (
                <button
                  className="reorderable-list__remove-btn"
                  onClick={() => onRemove(item, index)}
                  type="button"
                >
                  {removeButtonContent}
                </button>
              ) : (
                <Button
                  icon={mdiClose}
                  size="xs"
                  variant="ghost"
                  className="reorderable-list__remove-btn"
                  onClick={() => onRemove(item, index)}
                />
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

export default ReorderableList;
