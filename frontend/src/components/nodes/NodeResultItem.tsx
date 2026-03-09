/**
 * NodeResultItem - Shared node result row for all node-picker popups.
 *
 * Renders a single selectable node with optional breadcrumb path above and
 * icon + name row. Shared between SuggestionPopup, NodeSelector, and any
 * other component that presents a searchable list of nodes.
 */
import type { Node } from '@/types';
import { NodeIcon, CheckIcon } from '../core/icons';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import './NodeResultItem.css';

export interface NodeResultItemProps {
  node: Node;
  /** Pre-computed ancestor breadcrumb string, e.g. "Root / Parent" */
  parentPath?: string;
  /** Pre-computed display classes (excluding system page class) */
  displayClasses?: Array<{ id: number; name: string }>;
  /** Whether this row is keyboard-highlighted */
  isHighlighted?: boolean;
  /** Whether this item is already selected — renders a checkmark */
  isSelected?: boolean;
  onClick: () => void;
  onMouseEnter?: () => void;
  /** Extra CSS classes on the root button */
  className?: string;
  /** Slot rendered before the icon (e.g. a Checkbox in multi-select mode) */
  before?: React.ReactNode;
  /** Slot rendered after the name (e.g. an alias badge) */
  after?: React.ReactNode;
  /** Override the default NodeIcon (e.g. BulletIcon for blocks) */
  iconOverride?: React.ReactNode;
}

export function NodeResultItem({
  node,
  parentPath,
  displayClasses,
  isHighlighted = false,
  isSelected = false,
  onClick,
  onMouseEnter,
  className = '',
  before,
  after,
  iconOverride,
}: NodeResultItemProps) {
  return (
    <button
      className={`node-result-item${isHighlighted ? ' node-result-item--highlighted' : ''}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      {parentPath && (
        <div className="node-result-item__crumbs" title={parentPath}>
          {parentPath}
        </div>
      )}
      <div className="node-result-item__row">
        {before}
        <span className="node-result-item__icon">
          {iconOverride ?? <NodeIcon icon={node.icon} isPage={node.is_page} size="sm" />}
        </span>
        <span className="node-result-item__name">
          {nodeNameToText(node.name) || 'Untitled'}
        </span>
        {after}
        {displayClasses && displayClasses.length > 0 && (
          <span className="node-result-item__class-pills">
            {displayClasses.map(cls => (
              <span key={cls.id} className="node-result-item__class-pill">{cls.name}</span>
            ))}
          </span>
        )}
        {isSelected && (
          <span className="node-result-item__check">
            <CheckIcon size="xs" />
          </span>
        )}
      </div>
    </button>
  );
}
