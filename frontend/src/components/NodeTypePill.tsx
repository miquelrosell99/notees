/**
 * NodeTypePill - A pill that displays a node type with icon and optional remove button
 * 
 * Used in:
 * - Block component (to the right of blocks)
 * - PageHeader (between title and properties)
 */
import { Pill } from './Pill';
import { NodeIcon, CloseIcon } from './icons';
import type { Node } from '@/types';
import './NodeTypePill.css';

interface NodeTypePillProps {
  /** The type node */
  typeNode: Node;
  /** Callback when clicking the pill (usually to navigate to the type) */
  onClick?: () => void;
  /** Callback when clicking the remove button */
  onRemove?: () => void;
  /** Whether the pill is read-only (hides remove button) */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

export function NodeTypePill({
  typeNode,
  onClick,
  onRemove,
  readOnly = false,
  className = '',
}: NodeTypePillProps) {
  const handleRemove = () => {
    onRemove?.();
  };

  const handleClick = () => {
    onClick?.();
  };

  return (
    <div 
      className={`node-type-pill ${className}`}
      onClick={handleClick}
      title={`Click to view ${typeNode.name}`}
    >
      <Pill
        text={typeNode.name}
        leftIcon={typeNode.icon ? <NodeIcon icon={typeNode.icon} isPage={true} size="xs" /> : undefined}
        rightIcon={!readOnly && onRemove ? <CloseIcon size="xs" /> : undefined}
        onRightIconClick={!readOnly ? handleRemove : undefined}
        color={typeNode.color || undefined}
      />
    </div>
  );
}
