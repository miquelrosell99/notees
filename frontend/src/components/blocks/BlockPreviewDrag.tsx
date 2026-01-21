/**
 * BlockPreviewDrag Component
 * 
 * A stateless, visual-only drag preview component for blocks.
 * Used during drag-and-drop operations to show a floating preview.
 * 
 * Features:
 * - Uses BlockPreview internally for consistent content rendering
 * - Optional bullet/icon display
 * - Floating/ghost visual styling
 * - No editing logic, drag handling, or domain state
 * 
 * Related:
 * - useDragPreview hook (hooks/useDragPreview.ts) - manages drag state
 * - BlockPreview - underlying content renderer
 */
import type { Node } from '@/types';
import { BlockPreview } from './BlockPreview';
import { Card } from '../core/Card';
import './BlockPreviewDrag.css';

export type BlockPreviewDragVariant = 'compact' | 'full';

export interface BlockPreviewDragProps {
  /** The node/block to render */
  node: Node;
  /** Preview style variant */
  variant?: BlockPreviewDragVariant;
  /** Whether to show the bullet/icon (default: true) */
  showBullet?: boolean;
  /** Additional CSS class */
  className?: string;
}

/**
 * BlockPreviewDrag - A visual preview component for dragged blocks.
 * 
 * This is a pure presentational component. Drag state management
 * should be handled by the parent or useDragPreview hook.
 * 
 * @example
 * // Basic usage with useDragPreview hook
 * const { draggedBlock, dragPosition, isDragging } = useDragPreview();
 * 
 * {isDragging && draggedBlock && (
 *   <div style={{ position: 'fixed', left: dragPosition.x, top: dragPosition.y }}>
 *     <BlockPreviewDrag node={draggedBlock} />
 *   </div>
 * )}
 */
export function BlockPreviewDrag({
  node,
  variant = 'compact',
  showBullet = true,
  className = '',
}: BlockPreviewDragProps) {
  const classes = [
    'block-preview-drag',
    `block-preview-drag--${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Card
      className={classes}
      elevation="high"
      padding
      paddingSize="sm"
    >
      <BlockPreview
        node={node}
        variant="simple"
        showBullet={showBullet}
        size="sm"
        className="block-preview-drag__content"
      />
    </Card>
  );
}
