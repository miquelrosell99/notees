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

import { GenericConditionRenderer } from './GenericConditionRenderer';
import { isSystemNode, isNodeEditable } from '@/types/queryAST';
import type { ConditionNode } from '@/types/queryAST';
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
      readOnly={!isEditable}
    />
  );
}

// ==================== Prose Condition Row ====================

interface ProseConditionRowProps {
  condition: ConditionNode;
  onUpdate: (condition: ConditionNode) => void;
  readOnly?: boolean;
}

function ProseConditionRow({
  condition,
  onUpdate,
  readOnly = false,
}: ProseConditionRowProps) {
  
  const isSystem = isSystemNode(condition);
  const isEditable = isNodeEditable(condition);
  const effectiveReadOnly = readOnly || !isEditable;
  
  return (
    <div className={`prose-condition ${isSystem ? 'prose-condition--system' : ''}`}>
      {/* System lock icon */}
      {isSystem && (
        <span 
          className="prose-condition__lock" 
          title="This filter is required for this view type"
        >
          🔒
        </span>
      )}
      
      {/* Condition content - using generic renderer */}
      <GenericConditionRenderer
        condition={condition}
        onUpdate={onUpdate}
        readOnly={effectiveReadOnly}
      />
    </div>
  );
}

export default ProseConditionBuilder;
