/**
 * useDragPreview Hook
 * 
 * Manages drag preview state for block drag-and-drop operations.
 * Use with BlockPreviewDrag component for visual feedback.
 * 
 * @example
 * const { draggedBlock, dragPosition, isDragging, startDrag, endDrag } = useDragPreview();
 * 
 * // In your drag source
 * onDragStart={(e) => startDrag(node, e)}
 * 
 * // Render the preview
 * {isDragging && draggedBlock && (
 *   <div style={{ position: 'fixed', left: dragPosition.x + 10, top: dragPosition.y + 10 }}>
 *     <BlockPreviewDrag node={draggedBlock} />
 *   </div>
 * )}
 */
import { useState, useEffect, useCallback } from 'react';
import type { Node } from '@/types';

export interface DragPreviewState {
  /** The node being dragged, or null */
  draggedBlock: Node | null;
  /** Current cursor position */
  dragPosition: { x: number; y: number };
  /** Whether a drag is currently active */
  isDragging: boolean;
  /** Start a drag operation */
  startDrag: (block: Node, e: React.MouseEvent) => void;
  /** End the current drag operation */
  endDrag: () => void;
}

export function useDragPreview(): DragPreviewState {
  const [draggedBlock, setDraggedBlock] = useState<Node | null>(null);
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      setDragPosition({ x: e.clientX, y: e.clientY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setDraggedBlock(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const startDrag = useCallback((block: Node, e: React.MouseEvent) => {
    setDraggedBlock(block);
    setDragPosition({ x: e.clientX, y: e.clientY });
    setIsDragging(true);
  }, []);

  const endDrag = useCallback(() => {
    setIsDragging(false);
    setDraggedBlock(null);
  }, []);

  return {
    draggedBlock,
    dragPosition,
    isDragging,
    startDrag,
    endDrag,
  };
}
