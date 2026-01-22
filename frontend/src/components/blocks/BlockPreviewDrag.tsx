/**
 * BlockPreviewDrag Component
 * 
 * @deprecated Use BlockDrag instead
 * 
 * This component is kept for backward compatibility but will be removed.
 */
import type { Node } from '@/types';
import { BlockDrag } from './BlockDrag';

/** @deprecated Use BlockDrag variant instead */
export type BlockPreviewDragVariant = 'compact' | 'full';

export interface BlockPreviewDragProps {
  /** The node/block to render */
  node: Node;
  /** @deprecated Ignored - use BlockDrag for consistent styling */
  variant?: BlockPreviewDragVariant;
  /** Whether to show the bullet/icon (default: true) */
  showBullet?: boolean;
  /** Additional CSS class */
  className?: string;
}

/**
 * @deprecated Use BlockDrag component instead
 */
export function BlockPreviewDrag({
  node,
  variant: _variant, // Ignored
  showBullet = true,
  className = '',
}: BlockPreviewDragProps) {
  return (
    <BlockDrag
      node={node}
      showBullet={showBullet}
      className={className}
    />
  );
}
