/**
 * ListSortable Component
 * 
 * A reusable sortable list component with animated drag-and-drop reordering.
 * Each item has: icon (left) → text (center) → optional action (right)
 * 
 * Uses native drag-and-drop patterns with smooth auto-scrolling.
 * 
 * NOTE: This is a lightweight alternative to @dnd-kit for simple list reordering.
 * Consider migrating to @dnd-kit's SortableList for consistency across the app.
 * Currently used in: ClassColorsPanel, NodeListView, NavigationSidebar, NodeGraphView.
 */
import { useRef, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import './ListSortable.css';

export interface ListSortableItem {
  id: string | number;
}

export interface ListSortableProps<T extends ListSortableItem> {
  /** Array of items to display */
  items: T[];
  /** Callback when items are reordered */
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** Render the icon component (left side) */
  renderIcon?: (item: T, index: number) => ReactNode;
  /** Render the text content (center) */
  renderText: (item: T, index: number) => ReactNode;
  /** Render a single action button (right side, optional) - deprecated, use renderActions */
  renderAction?: (item: T, index: number) => ReactNode;
  /** Render multiple action buttons (right side, optional) */
  renderActions?: (item: T, index: number) => ReactNode[];
  /** Click handler for the entire row */
  onItemClick?: (item: T, index: number) => void;
  /** Additional CSS class for the container */
  className?: string;
  /** Additional CSS class for each item */
  itemClassName?: string;
  /** Whether to show the drag handle */
  showDragHandle?: boolean;
  /** Custom drag handle content */
  dragHandleContent?: ReactNode;
}

interface DragState {
  dragIndex: number;
  targetIndex: number;
  mouseYInContent: number;
  grabOffset: number;
}

export function ListSortable<T extends ListSortableItem>({
  items,
  onReorder,
  renderIcon,
  renderText,
  renderAction,
  renderActions,
  onItemClick,
  className = '',
  itemClassName = '',
  showDragHandle = true,
  dragHandleContent,
}: ListSortableProps<T>) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [isSettling, setIsSettling] = useState(false);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const itemHeightRef = useRef(40);
  const scrollRAF = useRef<number | null>(null);
  const lastClientY = useRef(0);

  // Measure item height
  useEffect(() => {
    if (containerRef.current) {
      const firstItem = containerRef.current.querySelector('.list-sortable__item') as HTMLElement;
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

    const firstItem = container.querySelector('.list-sortable__item') as HTMLElement;
    if (firstItem) {
      itemHeightRef.current = firstItem.offsetHeight;
    }

    const containerRect = container.getBoundingClientRect();
    const itemTop = index * itemHeightRef.current;
    const mouseYInContent = e.clientY - containerRect.top + container.scrollTop;
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

      const scrollZone = 40;
      const maxSpeed = 6;
      
      const distFromTop = e.clientY - containerRect.top;
      const distFromBottom = containerRect.bottom - e.clientY;
      
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
      if (scrollRAF.current) {
        cancelAnimationFrame(scrollRAF.current);
        scrollRAF.current = null;
      }

      const { dragIndex, targetIndex } = dragState;
      
      setIsSettling(true);
      setDragState(null);
      
      if (dragIndex !== targetIndex) {
        onReorder(dragIndex, targetIndex);
      }
      
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
      const naturalTop = dragIndex * itemHeight;
      const desiredTop = mouseYInContent - grabOffset;
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

    let shift = 0;
    
    if (dragIndex < targetIndex) {
      if (index > dragIndex && index <= targetIndex) {
        shift = -itemHeight;
      }
    } else if (dragIndex > targetIndex) {
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

  // Handle item click
  const handleItemClick = useCallback((item: T, index: number) => {
    // Don't trigger click if we were dragging
    if (dragState) return;
    onItemClick?.(item, index);
  }, [dragState, onItemClick]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div 
      ref={containerRef}
      className={`list-sortable ${className} ${dragState ? 'list-sortable--dragging' : ''}`}
    >
      {items.map((item, index) => {
        const isDragging = dragState?.dragIndex === index;
        const style = getItemStyle(index);
        
        return (
          <div
            key={item.id}
            className={`list-sortable__item ${itemClassName} ${isDragging ? 'list-sortable__item--dragging' : ''} ${isSettling ? 'list-sortable__item--settling' : ''}`}
            style={style}
            onClick={() => handleItemClick(item, index)}
          >
            {/* Drag handle */}
            {showDragHandle && (
              <span 
                className="list-sortable__drag-handle"
                onMouseDown={(e) => handleDragStart(index, e)}
              >
                {dragHandleContent || '⋮⋮'}
              </span>
            )}
            
            {/* Icon (optional, left) */}
            {renderIcon && (
              <div className="list-sortable__icon">
                {renderIcon(item, index)}
              </div>
            )}
            
            {/* Text content (center) */}
            <div className="list-sortable__text">
              {renderText(item, index)}
            </div>
            
            {/* Actions (optional, right) - supports both single and multiple */}
            {(renderActions || renderAction) && (
              <div className="list-sortable__actions">
                {renderActions 
                  ? renderActions(item, index).map((action, actionIndex) => (
                      <div key={actionIndex} className="list-sortable__action">
                        {action}
                      </div>
                    ))
                  : renderAction && (
                      <div className="list-sortable__action">
                        {renderAction(item, index)}
                      </div>
                    )
                }
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default ListSortable;
