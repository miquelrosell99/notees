/**
 * DraggedBlock Component
 * 
 * A floating preview component that appears when a block is being dragged.
 * Uses the Card component for consistent styling.
 * 
 * NOTE: Moved out of core/ - has domain knowledge (Node type, BlockContent)
 */
import { useEffect, useState } from 'react';
import { Card } from '../core/Card';
import { BlockContent } from './BlockContent';
import { Bullet } from './Bullet';
import type { Node } from '@/types';
import './DraggedBlock.css';

export interface DraggedBlockProps {
  /** The block being dragged */
  block: Node | null;
  /** Current mouse position */
  position: { x: number; y: number };
  /** Whether the drag is active */
  isDragging: boolean;
}

/**
 * DraggedBlock component - shows a preview of the dragged block.
 * Renders as a portal at the document level for proper z-indexing.
 */
export function DraggedBlock({
  block,
  position,
  isDragging,
}: DraggedBlockProps) {
  const [visible, setVisible] = useState(false);

  // Slight delay before showing to avoid flash on quick clicks
  useEffect(() => {
    if (isDragging) {
      const timer = setTimeout(() => setVisible(true), 50);
      return () => clearTimeout(timer);
    } else {
      setVisible(false);
    }
  }, [isDragging]);

  if (!isDragging || !block || !visible) {
    return null;
  }

  return (
    <div
      className="dragged-block"
      style={{
        left: position.x + 10,
        top: position.y + 10,
      }}
    >
      <Card
        className="dragged-block__card"
        elevation="high"
        padding
        paddingSize="sm"
      >
        <div className="dragged-block__content">
          <Bullet
            size="sm"
            interactive={false}
          />
          <div className="dragged-block__text">
            <BlockContent
              content={block.name || 'Untitled'}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * Hook to manage drag preview state.
 * Can be used with DraggedBlock component.
 */
export function useDragPreview() {
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

  const startDrag = (block: Node, e: React.MouseEvent) => {
    setDraggedBlock(block);
    setDragPosition({ x: e.clientX, y: e.clientY });
    setIsDragging(true);
  };

  const endDrag = () => {
    setIsDragging(false);
    setDraggedBlock(null);
  };

  return {
    draggedBlock,
    dragPosition,
    isDragging,
    startDrag,
    endDrag,
  };
}
