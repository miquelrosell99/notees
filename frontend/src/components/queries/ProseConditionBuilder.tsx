/**
 * ProseConditionBuilder Component
 * 
 * Inline sentence-based condition builder that replaces boxed UI.
 * Renders conditions as natural language with inline controls.
 */

import { useCallback } from 'react';
import { mdiClose, mdiPlusBox, mdiLock } from '@mdi/js';
import Icon from '@mdi/react';
import { Button } from '../core/Button';
import { Dropdown } from '../core/Dropdown';
import { TextField } from '../core/TextField';
import { getConditionLabel } from '@/lib/astProseRenderer';
import { createConditionFromType } from '@/lib/queryASTHelpers';
import { isSystemNode, isNodeEditable, isNodeRemovable } from '@/types/queryAST';
import type { GroupNode, ConditionNode, ContentOperator, PropertyOperator } from '@/types/queryAST';
import './ProseConditionBuilder.css';

// ==================== Types ====================

interface ProseConditionBuilderProps {
  group: GroupNode;
  onUpdate: (group: GroupNode) => void;
  readOnly?: boolean;
  depth?: number;
}

// ==================== Prose Condition Row ====================

interface ProseConditionRowProps {
  condition: ConditionNode;
  onUpdate: (condition: ConditionNode) => void;
  onDelete: () => void;
  readOnly?: boolean;
  showLogic?: string; // "and" | "or" | null
}

function ProseConditionRow({
  condition,
  onUpdate,
  onDelete,
  readOnly = false,
  showLogic,
}: ProseConditionRowProps) {
  
  const isSystem = isSystemNode(condition);
  const isEditable = isNodeEditable(condition);
  const isRemovable = isNodeRemovable(condition);
  const effectiveReadOnly = readOnly || !isEditable;
  
  // Render based on condition type
  const renderCondition = () => {
    switch (condition.condition_type) {
      case 'reference':
        return (
          <div className="prose-condition__inline">
            <Dropdown
              value="references"
              onChange={() => {}}
              disabled={effectiveReadOnly}
              options={[
                { value: 'references', label: 'references' },
                { value: 'referenced_by', label: 'is referenced by' },
              ]}
              size="sm"
            />
            <span className="prose-condition__token">this node</span>
          </div>
        );
      
      case 'content':
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__text">content</span>
            <Dropdown
              value={condition.operator}
              onChange={(value) => onUpdate({ ...condition, operator: value as ContentOperator })}
              disabled={effectiveReadOnly}
              options={[
                { value: 'contains', label: 'contains' },
                { value: 'starts_with', label: 'starts with' },
                { value: 'ends_with', label: 'ends with' },
                { value: 'equals', label: 'equals' },
                { value: 'regex', label: 'matches pattern' },
              ]}
              size="sm"
            />
            <TextField
              value={condition.value}
              onChange={(e) => onUpdate({ ...condition, value: e.target.value })}
              placeholder="text..."
              disabled={effectiveReadOnly}
              size="sm"
            />
          </div>
        );
      
      case 'property':
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__text">property</span>
            <TextField
              value={condition.property_name}
              onChange={(e) => onUpdate({ ...condition, property_name: e.target.value })}
              placeholder="name"
              disabled={effectiveReadOnly}
              size="sm"
            />
            <Dropdown
              value={condition.operator}
              onChange={(value) => onUpdate({ ...condition, operator: value as PropertyOperator })}
              disabled={effectiveReadOnly}
              options={[
                { value: 'equals', label: 'equals' },
                { value: 'not_equals', label: '≠' },
                { value: 'contains', label: 'contains' },
                { value: 'is_empty', label: 'is empty' },
                { value: 'is_not_empty', label: 'is not empty' },
              ]}
              size="sm"
            />
            {condition.operator !== 'is_empty' && condition.operator !== 'is_not_empty' && (
              <TextField
                value={String(condition.value || '')}
                onChange={(e) => onUpdate({ ...condition, value: e.target.value })}
                placeholder="value"
                disabled={effectiveReadOnly}
                size="sm"
              />
            )}
          </div>
        );
      
      case 'type':
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__text">tagged with</span>
            <span className="prose-condition__token">{condition.type_uuid}</span>
          </div>
        );
      
      default:
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__text">{getConditionLabel(condition)}</span>
          </div>
        );
    }
  };
  
  return (
    <div className="prose-condition">
      {showLogic && (
        <span className="prose-condition__logic">{showLogic}</span>
      )}
      {isSystem && (
        <span className="prose-condition__system-icon" title="This condition is required for this view">
          <Icon path={mdiLock} size={0.6} />
        </span>
      )}
      {renderCondition()}
      {!readOnly && isRemovable && (
        <Button
          icon={mdiClose}
          iconOnly
          variant="ghost"
          size="xs"
          onClick={onDelete}
          className="prose-condition__delete"
        />
      )}
    </div>
  );
}

// ==================== Main Component ====================

export function ProseConditionBuilder({
  group,
  onUpdate,
  readOnly = false,
  depth = 0,
}: ProseConditionBuilderProps) {
  
  // Handle adding a condition
  const handleAdd = useCallback(() => {
    const newCondition = createConditionFromType('reference');
    onUpdate({
      ...group,
      children: [...group.children, newCondition],
    });
  }, [group, onUpdate]);
  
  // Handle updating a child
  const handleUpdateChild = useCallback((index: number, condition: ConditionNode) => {
    const newChildren = [...group.children];
    newChildren[index] = condition;
    onUpdate({
      ...group,
      children: newChildren,
    });
  }, [group, onUpdate]);
  
  // Handle deleting a child
  const handleDeleteChild = useCallback((index: number) => {
    onUpdate({
      ...group,
      children: group.children.filter((_, i) => i !== index),
    });
  }, [group, onUpdate]);
  
  // Handle logic change
  const handleLogicChange = useCallback((logic: 'AND' | 'OR') => {
    onUpdate({
      ...group,
      logic,
    });
  }, [group, onUpdate]);
  
  const isEmpty = group.children.length === 0;
  const logicLabel = group.logic === 'AND' ? 'and' : 'or';
  
  return (
    <div className="prose-condition-builder">
      {isEmpty ? (
        <p className="prose-condition-builder__empty">
          No conditions — all nodes will be shown
        </p>
      ) : (
        <>
          {/* Logic selector for multiple conditions */}
          {group.children.length > 1 && (
            <div className="prose-condition-builder__logic">
              <span className="prose-condition-builder__logic-text">Match</span>
              <Dropdown
                value={group.logic}
                onChange={(value) => handleLogicChange(value as 'AND' | 'OR')}
                disabled={readOnly}
                options={[
                  { value: 'AND', label: 'all' },
                  { value: 'OR', label: 'any' },
                ]}
                size="sm"
              />
              <span className="prose-condition-builder__logic-text">of the following:</span>
            </div>
          )}
          
          {/* Render conditions */}
          <div className="prose-condition-builder__list">
            {group.children.map((child, index) => {
              if (child.type === 'condition') {
                return (
                  <ProseConditionRow
                    key={index}
                    condition={child}
                    onUpdate={(updated) => handleUpdateChild(index, updated)}
                    onDelete={() => handleDeleteChild(index)}
                    readOnly={readOnly}
                    showLogic={index > 0 ? logicLabel : undefined}
                  />
                );
              } else if (child.type === 'group') {
                // Nested group - render with indentation
                return (
                  <div key={index} className="prose-condition-builder__nested">
                    {index > 0 && (
                      <span className="prose-condition__logic">{logicLabel}</span>
                    )}
                    <span className="prose-condition-builder__nested-label">(</span>
                    <ProseConditionBuilder
                      group={child}
                      onUpdate={(updated) => {
                        const newChildren = [...group.children];
                        newChildren[index] = updated;
                        onUpdate({ ...group, children: newChildren });
                      }}
                      readOnly={readOnly}
                      depth={depth + 1}
                    />
                    <span className="prose-condition-builder__nested-label">)</span>
                    {!readOnly && (
                      <Button
                        icon={mdiClose}
                        iconOnly
                        variant="ghost"
                        size="xs"
                        onClick={() => handleDeleteChild(index)}
                        className="prose-condition__delete"
                      />
                    )}
                  </div>
                );
              }
              return null;
            })}
          </div>
        </>
      )}
      
      {/* Add condition button */}
      {!readOnly && (
        <Button
          icon={mdiPlusBox}
          onClick={handleAdd}
          variant="ghost"
          size="sm"
          className="prose-condition-builder__add"
        >
          Add condition
        </Button>
      )}
    </div>
  );
}

export default ProseConditionBuilder;
