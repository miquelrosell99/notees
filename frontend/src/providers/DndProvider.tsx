/**
 * DndProvider
 * 
 * App-level drag-and-drop context using @dnd-kit.
 * Wraps the entire application to provide consistent DnD behavior.
 * 
 * Handles drag events for all draggable items in the app:
 * - Blocks (node hierarchy)
 * - Query blocks (query builder)
 * - Cards (card view)
 * - Sidebar items (navigation)
 */

import { type ReactNode, useCallback, useState } from 'react';
import {
  DndContext,
  closestCenter,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  DragOverlay as DndKitDragOverlay,
  defaultDropAnimationSideEffects,
  type DropAnimation,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { useDndSensors } from '@/features/content/hooks/dnd/useDndSensors';
import { useMoveNode } from '@/hooks';

// ==================== Types ====================

interface DndProviderProps {
  children: ReactNode;
}

// ==================== Configuration ====================

/**
 * Custom collision detection that combines multiple strategies
 * - Starts with pointerWithin for precision
 * - Falls back to rectIntersection for overlapping items
 * - Finally uses closestCenter for edge cases
 */
const customCollisionDetection: CollisionDetection = (args) => {
  // First, check if pointer is directly over something
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) {
    return pointerCollisions;
  }

  // Then check for rectangle intersection
  const intersectingCollisions = rectIntersection(args);
  if (intersectingCollisions.length > 0) {
    return intersectingCollisions;
  }

  // Finally fall back to closest center
  return closestCenter(args);
};

/**
 * Drop animation configuration
 */
const dropAnimation: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: '0.5',
      },
    },
  }),
};

// ==================== Component ====================

/**
 * Drag-and-drop provider for the entire application
 * 
 * @example
 * ```tsx
 * <DndProvider>
 *   <App />
 * </DndProvider>
 * ```
 */
export function DndProvider({ children }: DndProviderProps) {
  const sensors = useDndSensors();
  const moveNode = useMoveNode();
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  // Track drop position locally instead of via store
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'inside'>('after');

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || !active.data.current) return;

    // Determine drop position based on pointer location
    if (active.data.current.type === 'block') {
      const overRect = over.rect;
      if (overRect && event.delta.y !== 0) {
        const relativeY = event.delta.y;
        const height = overRect.height;

        if (relativeY < height * 0.3) {
          setDropPosition('before');
        } else if (relativeY > height * 0.7) {
          setDropPosition('after');
        } else {
          setDropPosition('inside');
        }
      }
    }
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    
    setActiveId(null);

    if (!over || !active.data.current) return;

    // Handle block drop
    if (active.data.current.type === 'block') {
      const activeBlockId = active.data.current.blockId;
      const overBlockId = over.data.current?.blockId;
      const overParentId = over.data.current?.parentId;
      const overSequence = over.data.current?.sequence;

      if (!overBlockId || activeBlockId === overBlockId) return;

      // Perform the move based on drop position
      if (dropPosition === 'inside') {
        moveNode.mutate({
          id: activeBlockId,
          parentId: overBlockId,
          position: 0,
        });
      } else if (dropPosition === 'before') {
        moveNode.mutate({
          id: activeBlockId,
          parentId: overParentId ?? null,
          position: overSequence ?? 0,
        });
      } else if (dropPosition === 'after') {
        moveNode.mutate({
          id: activeBlockId,
          parentId: overParentId ?? null,
          position: (overSequence ?? 0) + 1,
        });
      }
    }
  }, [moveNode, dropPosition]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={customCollisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {children}
      
      {/* Global drag overlay portal */}
      <DndKitDragOverlay dropAnimation={dropAnimation}>
        {activeId ? (
          <div style={{
            background: 'var(--background)',
            border: 'var(--border-width-default) solid var(--color-outline-variant)',
            borderRadius: 'var(--shape-small)',
            padding: 'var(--spacing-2)',
            opacity: 'var(--opacity-80)',
          }}>
          </div>
        ) : null}
      </DndKitDragOverlay>
    </DndContext>
  );
}
