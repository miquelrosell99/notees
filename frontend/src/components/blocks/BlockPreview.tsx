/**
 * BlockPreview Component
 * 
 * @deprecated Use Block component directly with canEdit={false}, canMove={false}, canSelect={false}
 * 
 * This component is kept for backward compatibility but will be removed in a future version.
 * It's a thin wrapper around Block with readonly capabilities.
 */
import type { Node } from '@/types';
import { Block } from './Block';

export interface BlockPreviewProps {
  /** Full node object */
  node?: Node;
  /** Direct content string (alternative to node) */
  content?: string;
  /** Block ID for link click tracking */
  blockId?: number;
  /** Whether to show bullet point (default: true) */
  showBullet?: boolean;
  /** Whether to show icon in bullet (default: true) */
  showIcon?: boolean;
  /** Icon override */
  icon?: string | null;
  /** Whether to show classes (default: false) */
  showClasses?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Shift+click handler */
  onShiftClick?: () => void;
  /** Bullet click handler */
  onBulletClick?: () => void;
  /** Additional CSS class */
  className?: string;
  /** @deprecated Ignored - all BlockPreview is now simple/readonly */
  variant?: 'simple' | 'full';
  /** Suppress color styling on the block */
  suppressColor?: boolean;
  /** Property name for breadcrumb display */
  propertyName?: string;
}

/**
 * @deprecated Use Block component directly with capability flags instead
 */
export function BlockPreview({
  node,
  content,
  blockId,
  showBullet = true,
  showIcon: _showIcon, // Ignored - Block always shows icon via Bullet
  icon,
  showClasses = false,
  onClick,
  onShiftClick,
  onBulletClick,
  className = '',
  variant: _variant, // Ignored - kept for backward compatibility
  suppressColor = false,
  propertyName: _propertyName, // Ignored - kept for breadcrumb compatibility
}: BlockPreviewProps) {
  // Create a minimal node if only content/blockId provided
  const blockNode: Node = node ?? {
    id: blockId ?? 0,
    uuid: '',
    name: content ?? '',
    icon: icon ?? null,
    color: null,
    parent_id: null,
    page_id: null,
    sequence: 0,
    collapsed: false,
    active: true,
    is_page: false,
    create_date: '',
    write_date: '',
  };

  return (
    <div className={className} onClick={onClick}>
      <Block
        block={blockNode}
        parentId={null}
        showBullet={showBullet}
        showChildren={false}
        showClasses={showClasses}
        canMove={false}
        canEdit={false}
        canSelect={false}
        suppressColor={suppressColor}
        onBulletClick={onBulletClick ? () => onBulletClick() : undefined}
        onShiftClick={onShiftClick ? () => onShiftClick() : undefined}
      />
    </div>
  );
}

export default BlockPreview;
