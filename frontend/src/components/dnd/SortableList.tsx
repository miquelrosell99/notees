/**
 * SortableList Component
 * 
 * Generic sortable list container using @dnd-kit.
 * Handles the sorting logic and provides callbacks for reordering.
 */

import { type ReactNode, useState, useCallback } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  type SortingStrategy,
} from '@dnd-kit/sortable';

export interface SortableListProps<T> {
  /** Array of items to sort */
  items: T[];
  /** Function to extract unique ID from each item */
  getId: (item: T) => string | number;
  /** Callback when items are reordered */
  onReorder: (items: T[]) => void;
  /** Render function for each item */
  children: (item: T, index: number) => ReactNode;
  /** Sorting strategy */
  strategy?: 'vertical' | 'horizontal' | 'grid';
  /** Whether the list is disabled */
  disabled?: boolean;
  /** Additional class name */
  className?: string;
}

const STRATEGY_MAP: Record<string, SortingStrategy> = {
  vertical: verticalListSortingStrategy,
  horizontal: horizontalListSortingStrategy,
  grid: rectSortingStrategy,
};

/**
 * Sortable list component with drag-and-drop reordering
 * 
 * @example
 * ```tsx
 * const [items, setItems] = useState([...]);
 * 
 * <SortableList
 *   items={items}
 *   getId={(item) => item.id}
 *   onReorder={setItems}
 * >
 *   {(item, index) => (
 *     <SortableItem key={item.id} id={item.id}>
 *       {({ setNodeRef, style, attributes, listeners }) => (
 *         <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
 *           {item.name}
 *         </div>
 *       )}
 *     </SortableItem>
 *   )}
 * </SortableList>
 * ```
 */
export function SortableList<T>({
  items,
  getId,
  onReorder,
  children,
  strategy = 'vertical',
  disabled = false,
  className = '',
}: SortableListProps<T>) {
  const [, setActiveId] = useState<UniqueIdentifier | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      if (over && active.id !== over.id) {
        const oldIndex = items.findIndex((item) => getId(item) === active.id);
        const newIndex = items.findIndex((item) => getId(item) === over.id);

        if (oldIndex !== -1 && newIndex !== -1) {
          const reorderedItems = arrayMove(items, oldIndex, newIndex);
          onReorder(reorderedItems);
        }
      }

      setActiveId(null);
    },
    [items, getId, onReorder]
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  const itemIds = items.map(getId);

  if (disabled) {
    return (
      <div className={className}>
        {items.map((item, index) => children(item, index))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={itemIds} strategy={STRATEGY_MAP[strategy]}>
        <div className={className}>
          {items.map((item, index) => children(item, index))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
