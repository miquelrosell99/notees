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
import { useDndSensors } from '@/hooks/dnd/useDndSensors';
import { useMoveNode } from '@/hooks';
import { useBlockSelectionStore } from '@/stores/blockSelectionStore';

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
  const { startDrag, updateDragTarget, endDrag } = useBlockSelectionStore();
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { active } = event;
    setActiveId(active.id);
    
    // Handle block drag
    if (active.data.current?.type === 'block') {
      const blockId = active.data.current.blockId;
      startDrag(blockId);
    }
  }, [startDrag]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || !active.data.current) return;

    // Handle block drag over
    if (active.data.current.type === 'block') {
      const overBlockId = over.data.current?.blockId;
      if (!overBlockId) return;

      // Determine drop position based on pointer location
      const overRect = over.rect;
      if (overRect && event.delta.y !== 0) {
        const pointerY = event.delta.y + overRect.top;
        const relativeY = pointerY - overRect.top;
        const height = overRect.height;

        let position: 'before' | 'after' | 'inside';
        if (relativeY < height * 0.3) {
          position = 'before';
        } else if (relativeY > height * 0.7) {
          position = 'after';
        } else {
          position = 'inside';
        }

        updateDragTarget(overBlockId, position);
      }
    }
  }, [updateDragTarget]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    
    setActiveId(null);

    if (!over || !active.data.current) {
      endDrag();
      return;
    }

    // Handle block drop
    if (active.data.current.type === 'block') {
      const activeBlockId = active.data.current.blockId;
      const overBlockId = over.data.current?.blockId;
      const overParentId = over.data.current?.parentId;
      const overSequence = over.data.current?.sequence;

      if (!overBlockId || activeBlockId === overBlockId) {
        endDrag();
        return;
      }

      // Get drop position from store
      const dragState = useBlockSelectionStore.getState().dragState;
      const dropPosition = dragState.dropPosition || 'after';

      // Perform the move based on drop position
      if (dropPosition === 'inside') {
        // Move as first child of target block
        moveNode.mutate({
          id: activeBlockId,
          parentId: overBlockId,
          position: 0,
        });
      } else if (dropPosition === 'before') {
        // Move before target block (same parent as target)
        moveNode.mutate({
          id: activeBlockId,
          parentId: overParentId ?? null,
          position: overSequence ?? 0,
        });
      } else if (dropPosition === 'after') {
        // Move after target block (same parent as target)
        moveNode.mutate({
          id: activeBlockId,
          parentId: overParentId ?? null,
          position: (overSequence ?? 0) + 1,
        });
      }

      endDrag();
    }
  }, [moveNode, endDrag]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    endDrag();
  }, [endDrag]);

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
            border: '1px solid var(--border)',
            borderRadius: '4px',
            padding: '0.5rem',
            opacity: 0.8,
          }}>
            Dragging block...
          </div>
        ) : null}
      </DndKitDragOverlay>
    </DndContext>
  );
}
