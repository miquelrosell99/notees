/**
 * BlockDrag Component
 * 
 * A floating preview of a block shown during drag operations.
 * Uses Card for elevation and Block for consistent rendering.
 */
import type { Node } from '@/types';
import { Card } from '../core/Card';
import { Block } from './Block';
import './BlockDrag.css';

export interface BlockDragProps {
  /** Node to preview */
  node: Node;
  /** Whether to show the bullet (default: true) */
  showBullet?: boolean;
  /** Additional CSS class */
  className?: string;
}

export function BlockDrag({
  node,
  showBullet = true,
  className = '',
}: BlockDragProps) {
  const classes = [
    'block-drag',
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
      <Block
        block={node}
        parentId={null}
        showBullet={showBullet}
        showChildren={false}
        showTypes={false}
        canMove={false}
        canEdit={false}
        canSelect={false}
      />
    </Card>
  );
}

export default BlockDrag;
