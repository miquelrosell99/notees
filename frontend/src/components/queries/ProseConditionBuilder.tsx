/**
 * ProseConditionBuilder Component
 * 
 * Sentence-based condition builder with:
 * - Inline dropdowns styled as text
 * - Muted system constraints with 🔒 icon
 * - No boxes or borders
 * - Plain language operators (and, or)
 * - Light indentation for hierarchy
 * 
 * Now uses config-driven GenericConditionRenderer to eliminate repetitive code.
 */

import { mdiLock } from '@mdi/js';
import Icon from '@mdi/react';
import { GenericConditionRenderer } from './GenericConditionRenderer';
import { isSystemNode, isNodeEditable, isNodeRemovable } from '@/types/queryAST';
import type { ConditionNode } from '@/types/queryAST';
import { Button } from '../core/Button';
import { DeleteIcon } from '../icons';
import './ProseConditionBuilder.css';

// ==================== Types ====================

interface ProseConditionBuilderProps {
  /** Single condition block to render */
  block: ConditionNode;
  /** Callback when condition changes */
  onChange: (condition: ConditionNode) => void;
  /** Callback when condition should be removed */
  onRemove: () => void;
  /** Whether this condition is read-only */
  readOnly?: boolean;
}

// ==================== Main Component ====================

/**
 * ProseConditionBuilder - Renders a single condition with inline editing
 */
export function ProseConditionBuilder({
  block,
  onChange,
  onRemove,
  readOnly = false,
}: ProseConditionBuilderProps) {
  
  // Safety check - if block is undefined, render nothing
  if (!block) {
    console.error('ProseConditionBuilder: block is undefined');
    return null;
  }
  
  const condition = block;
  const isEditable = !readOnly && isNodeEditable(condition);
  
  return (
    <ProseConditionRow
      condition={condition}
      onUpdate={onChange}
      onRemove={onRemove}
      readOnly={!isEditable}
    />
  );
}

// ==================== Prose Condition Row ====================

interface ProseConditionRowProps {
  condition: ConditionNode;
  onUpdate: (condition: ConditionNode) => void;
  onRemove: () => void;
  readOnly?: boolean;
}

function ProseConditionRow({
  condition,
  onUpdate,
  onRemove,
  readOnly = false,
}: ProseConditionRowProps) {
  
  const isSystem = isSystemNode(condition);
  const isEditable = isNodeEditable(condition);
  const canRemove = isNodeRemovable(condition);
  const effectiveReadOnly = readOnly || !isEditable;
  
  return (
    <div className={`prose-condition-card ${isSystem ? 'prose-condition-card--system' : ''}`}>
      {/* Drag Handle */}
      <div className="prose-condition-card__drag">
        <span className="prose-condition-card__drag-handle">⋮⋮</span>
      </div>
      
      {/* Condition content - type, operator, and target */}
      <div className="prose-condition-card__content">
        <GenericConditionRenderer
          condition={condition}
          onUpdate={onUpdate}
          readOnly={effectiveReadOnly}
        />
      </div>
      
      {/* Actions */}
      <div className="prose-condition-card__actions">
        {isSystem ? (
          <div 
            className="prose-condition-card__action" 
            title="This filter is required for this view type"
          >
            <Icon path={mdiLock} size={0.55} />
          </div>
        ) : canRemove && !readOnly ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={onRemove}
            title="Remove condition"
            className="prose-condition-card__action"
          >
            <DeleteIcon size="sm" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default ProseConditionBuilder;
