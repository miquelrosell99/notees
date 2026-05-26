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
import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { useListDragSort, type DragState } from '@/hooks/useListDragSort';
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
  /** Render a single action button (right side, optional) */
  renderAction?: (item: T, index: number) => ReactNode;
  /** Render multiple action buttons (right side, optional) */
  renderActions?: (item: T, index: number) => ReactNode[];
  /** Click handler for the entire row */
  onItemClick?: (item: T, index: number) => void;
  /** Context menu handler for the row */
  onItemContextMenu?: (item: T, event: React.MouseEvent) => void;
  /** Additional CSS class for the container */
  className?: string;
  /** Additional CSS class for each item */
  itemClassName?: string;
  /** Whether to show the drag handle */
  showDragHandle?: boolean;
  /** Custom drag handle content */
  dragHandleContent?: ReactNode;
}

export type { DragState };

export function ListSortable<T extends ListSortableItem>({
  items,
  onReorder,
  renderIcon,
  renderText,
  renderAction,
  renderActions,
  onItemClick,
  onItemContextMenu,
  className = '',
  itemClassName = '',
  showDragHandle = true,
  dragHandleContent,
}: ListSortableProps<T>) {
  const {
    containerRef,
    dragState,
    isSettling,
    handleDragStart,
    getItemStyle,
  } = useListDragSort({
    itemCount: items.length,
    itemSelector: '.list-sortable__item',
    onReorder,
    preventDefaultOnDragStart: true,
  });

  // Handle item click
  const handleItemClick = useCallback((item: T, index: number) => {
    // Don't trigger click if we were dragging
    if (dragState) return;
    onItemClick?.(item, index);
  }, [dragState, onItemClick]);

  // Handle context menu
  const handleItemContextMenu = useCallback((item: T, e: React.MouseEvent) => {
    onItemContextMenu?.(item, e);
  }, [onItemContextMenu]);

  // Handle drag handle mouse down - prevent click propagation
  const handleDragHandleMouseDown = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent item click
    handleDragStart(index, e);
  }, [handleDragStart]);

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
            onContextMenu={(e) => handleItemContextMenu(item, e)}
          >
            {/* Drag handle */}
            {showDragHandle && (
              <span
                className="list-sortable__drag-handle"
                onMouseDown={(e) => handleDragHandleMouseDown(index, e)}
                onClick={(e) => e.stopPropagation()}
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
