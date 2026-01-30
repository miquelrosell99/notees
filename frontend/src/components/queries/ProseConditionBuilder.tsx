/**
 * ProseConditionBuilder Component
 * 
 * Sentence-based condition builder with:
 * - Inline dropdowns styled as text
 * - Muted system constraints with 🔒 icon
 * - No boxes or borders
 * - Plain language operators (and, or)
 * - Light indentation for hierarchy
 */

import { useCallback } from 'react';
import { mdiClose } from '@mdi/js';
import Icon from '@mdi/react';
import { Button } from '../core/Button';
import { Dropdown } from '../core/Dropdown';
import { TextField } from '../core/TextField';
import { NodePillRow } from '../NodePillRow';
import { SingleNodeSelector } from './NodeSelectors';
import { useNode } from '@/hooks';
import { renderConditionProse } from '@/lib/astProseRenderer';
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
  logic?: string; // "and" | "or" | null
  isFirst?: boolean;
}

function ProseConditionRow({
  condition,
  onUpdate,
  onDelete,
  readOnly = false,
  logic,
  isFirst = false,
}: ProseConditionRowProps) {
  
  const isSystem = isSystemNode(condition);
  const isEditable = isNodeEditable(condition);
  const isRemovable = isNodeRemovable(condition);
  const effectiveReadOnly = readOnly || !isEditable;
  
  // Render based on condition type
  const renderCondition = () => {
    switch (condition.condition_type) {
      case 'content':
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__word">content</span>
            <Dropdown
              value={condition.operator}
              onChange={(value) => onUpdate({ ...condition, operator: value as ContentOperator })}
              disabled={effectiveReadOnly}
              options={[
                { value: 'contains', label: 'contains' },
                { value: 'starts_with', label: 'starts with' },
                { value: 'ends_with', label: 'ends with' },
                { value: '=', label: 'equals' },
                { value: 'matches_regex', label: 'matches' },
              ]}
              size="sm"
            />
            <TextField
              value={condition.value}
              onChange={(e) => onUpdate({ ...condition, value: e.target.value })}
              placeholder="text..."
              disabled={effectiveReadOnly}
              size="sm"
              className="prose-condition__input"
            />
          </div>
        );
      
      case 'property':
        const showValue = condition.operator !== 'is_empty' && condition.operator !== 'is_not_empty';
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__word">property</span>
            <TextField
              value={condition.property_name}
              onChange={(e) => onUpdate({ ...condition, property_name: e.target.value })}
              placeholder="name"
              disabled={effectiveReadOnly}
              size="sm"
              className="prose-condition__input"
            />
            <Dropdown
              value={condition.operator}
              onChange={(value) => onUpdate({ ...condition, operator: value as PropertyOperator })}
              disabled={effectiveReadOnly}
              options={[
                { value: '=', label: 'equals' },
                { value: '!=', label: '≠' },
                { value: 'contains', label: 'contains' },
                { value: 'is_empty', label: 'is empty' },
                { value: 'is_not_empty', label: 'has value' },
              ]}
              size="sm"
            />
            {showValue && (
              <TextField
                value={String(condition.value || '')}
                onChange={(e) => onUpdate({ ...condition, value: e.target.value })}
                placeholder="value"
                disabled={effectiveReadOnly}
                size="sm"
                className="prose-condition__input"
              />
            )}
          </div>
        );
      
      case 'type': {
        const { data: selectedClass } = useNode(condition.type_id);
        const classNodes = selectedClass ? [selectedClass] : [];
        const operator = condition.operator || 'is';
        
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__word">class</span>
            <Dropdown
              value={operator}
              onChange={(value) => onUpdate({ ...condition, operator: value as 'is' | 'is_not' })}
              disabled={effectiveReadOnly}
              options={[
                { value: 'is', label: 'is' },
                { value: 'is_not', label: 'is not' },
              ]}
              size="sm"
            />
            <NodePillRow
              nodes={classNodes}
              searchMode="classes"
              emptyText="Select class"
              searchPlaceholder="Search classes..."
              onAdd={(node) => {
                onUpdate({
                  ...condition,
                  type_id: node.id,
                  type_uuid: node.uuid,
                });
              }}
              onRemove={() => {
                onUpdate({
                  ...condition,
                  type_id: undefined,
                  type_uuid: '',
                });
              }}
              readOnly={effectiveReadOnly}
            />
          </div>
        );
      }
      
      case 'reference':
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__word">references</span>
            <SingleNodeSelector
              mode="pages"
              selectedId={condition.target_id ?? null}
              onChange={(nodeId, node) => {
                onUpdate({
                  ...condition,
                  target_id: nodeId ?? undefined,
                  target_uuid: node?.uuid ?? '',
                });
              }}
              placeholder="Select node..."
              readOnly={effectiveReadOnly}
            />
          </div>
        );
      
      default:
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__text">{renderConditionProse(condition)}</span>
          </div>
        );
    }
  };
  
  return (
    <div className={`prose-condition ${isSystem ? 'prose-condition--system' : ''}`}>
      {/* Logic connector */}
      {!isFirst && logic && (
        <span className="prose-condition__connector">{logic}</span>
      )}
      
      {/* System lock icon */}
      {isSystem && (
        <span 
          className="prose-condition__lock" 
          title="This filter is required for this view type"
        >
          🔒
        </span>
      )}
      
      {/* Condition content */}
      {renderCondition()}
      
      {/* Delete button */}
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
  const handleAdd = useCallback((conditionType: string) => {
    const newCondition = createConditionFromType(conditionType);
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
    const newChildren = group.children.filter((_, i) => i !== index);
    onUpdate({
      ...group,
      children: newChildren,
    });
  }, [group, onUpdate]);
  
  // Determine logic word
  const logic = group.logic === 'OR' ? 'or' : 'and';
  const isEmpty = group.children.length === 0;
  
  return (
    <div className="prose-condition-builder" style={{ paddingLeft: depth > 0 ? `${depth * 16}px` : undefined }}>
      {/* Empty state */}
      {isEmpty && (
        <p className="prose-condition-builder__empty">
          No filters — all nodes will be shown
        </p>
      )}
      
      {/* Conditions */}
      {!isEmpty && (
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
                  logic={index > 0 ? logic : undefined}
                  isFirst={index === 0}
                />
              );
            } else if (child.type === 'group') {
              // Nested group
              return (
                <div key={index} className="prose-condition-builder__nested">
                  {index > 0 && <span className="prose-condition__connector">{logic}</span>}
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
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
      
      {/* Add filter dropdown */}
      {!readOnly && (
        <Dropdown
          value=""
          onChange={(value) => handleAdd(value)}
          placeholder="+ Add filter"
          options={[
            { value: 'content', label: 'Content' },
            { value: 'property', label: 'Property' },
            { value: 'type', label: 'Class' },
            { value: 'reference', label: 'References node' },
            { value: 'reference_path', label: 'Referenced by nodes that...' },
            { value: 'parent', label: 'Has parent' },
            { value: 'parent_path', label: 'Has ancestor' },
            { value: 'child', label: 'Has child' },
            { value: 'child_path', label: 'Has descendant' },
            { value: 'class_path', label: 'Has class in hierarchy' },
          ]}
          size="sm"
          className="prose-condition-builder__add-dropdown"
        />
      )}
    </div>
  );
}

export default ProseConditionBuilder;
