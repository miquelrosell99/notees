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

import { useState } from 'react';
import { mdiCursorPointer, mdiTextBoxMultipleOutline } from '@mdi/js';
import { Dropdown } from '../core/Dropdown';
import { TextField } from '../core/TextField';
import { SelectionButton } from '../core/SelectionButton';
import { NodePillRow } from '../NodePillRow';
import { SingleNodeSelector } from './NodeSelectors';
import { QueryBlockList } from './QueryBlockList';
import { useNode, useProperties } from '@/hooks';
import { renderConditionProse } from '@/lib/astProseRenderer';
import { isSystemNode, isNodeEditable } from '@/types/queryAST';
import type { 
  ConditionNode, 
  ContentOperator, 
  PropertyOperator, 
  ReferenceCondition,
  ClassCondition,
  ParentCondition
} from '@/types/queryAST';
import './ProseConditionBuilder.css';

// ==================== Helpers ====================

/**
 * Check if a condition type uses nested groups for filtering
 */
function usesNestedGroup(conditionType: string): boolean {
  return ['parent', 'parent_path', 'child', 'child_path', 'reference_path', 'class_path'].includes(conditionType);
}

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
  
  // HOOKS - Must be called unconditionally at the top level
  const { data: allProperties = [] } = useProperties();
  const { data: selectedClassNode } = useNode(condition.condition_type === 'class' ? condition.class_id || null : null);
  
  // State for selection modes - always initialize
  const isDynamicModeProperty = condition.condition_type === 'property' && condition.nested_group !== undefined;
  const isDynamicModeReference = condition.condition_type === 'reference' && condition.nested_group !== undefined;
  const isDynamicModeParent = condition.condition_type === 'parent' && condition.nested_group !== undefined;
  
  const [propSelectionMode, setPropSelectionMode] = useState(isDynamicModeProperty ? 'dynamic' : 'static');
  const [classSelectionMode, setClassSelectionMode] = useState('static');
  const [refSelectionMode, setRefSelectionMode] = useState(isDynamicModeReference ? 'dynamic' : 'static');
  const [parentSelectionMode, setParentSelectionMode] = useState(isDynamicModeParent ? 'dynamic' : 'static');
  
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
        
        // Built-in properties that are always available
        // Note: parent_id, is_page, name, is_favorite removed - they have dedicated query block types
        const builtInProperties = [
          { value: 'uuid', label: 'uuid' },
          { value: 'id', label: 'id' },
        ];
        
        // Custom properties from the database
        const customProperties = allProperties.map(prop => ({
          value: prop.name,
          label: prop.name,
        }));
        
        // Combine built-in and custom properties
        const propertyOptions = [...builtInProperties, ...customProperties];
        
        // Check if this property is of type 'node' (for static/dynamic selection)
        const selectedProperty = allProperties.find(p => p.name === condition.property_name);
        const isNodeProperty = selectedProperty?.type === 'node';
        
        return (
          <>
            <div className="prose-condition__inline">
              <span className="prose-condition__word">property</span>
              <Dropdown
                value={condition.property_name}
                onChange={(value) => onUpdate({ ...condition, property_name: value || '' })}
                options={propertyOptions}
                placeholder="Select property"
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
            </div>
            {showValue && isNodeProperty && (
              <SelectionButton
                value={propSelectionMode}
                onChange={(mode) => {
                  setPropSelectionMode(mode);
                    if (mode === 'static') {
                      onUpdate({
                        ...condition,
                        nested_group: undefined,
                      });
                    } else {
                      onUpdate({
                        ...condition,
                        value: '',
                        nested_group: {
                          type: 'group',
                          logic: 'AND',
                          children: [],
                        },
                      });
                    }
                  }}
                  options={[
                    { value: 'static', label: 'Static', icon: mdiCursorPointer },
                    { value: 'dynamic', label: 'Dynamic', icon: mdiTextBoxMultipleOutline },
                  ]}
                size="sm"
                  disabled={effectiveReadOnly}
                  className="prose-condition__selection-button"
                />
            )}
            {showValue && isNodeProperty && propSelectionMode === 'static' && (
              <div className="prose-condition__inline">
                <SingleNodeSelector
                  mode="pages"
                  selectedId={
                    condition.value === '{current_node_id}' ? -1 : 
                    null
                  }
                  onChange={(nodeId, node) => {
                    if (nodeId === -1) {
                      // Current Page selected
                      onUpdate({
                        ...condition,
                        value: '{current_node_id}',
                        nested_group: undefined,
                      });
                    } else {
                      onUpdate({
                        ...condition,
                        value: node?.uuid ?? '',
                        nested_group: undefined,
                      });
                    }
                  }}
                  placeholder="Select node..."
                  readOnly={effectiveReadOnly}
                />
              </div>
            )}
            {showValue && !isNodeProperty && (
              <div className="prose-condition__inline">
                <TextField
                  value={String(condition.value || '')}
                  onChange={(e) => onUpdate({ ...condition, value: e.target.value })}
                  placeholder="value"
                  disabled={effectiveReadOnly}
                  size="sm"
                  className="prose-condition__input"
                />
              </div>
            )}
            {showValue && isNodeProperty && propSelectionMode === 'dynamic' && (
              <div className="prose-condition__nested">
                <span className="prose-condition__word-muted">where</span>
                <QueryBlockList
                  blocks={condition.nested_group?.children || []}
                  parentLogic={condition.nested_group?.logic || 'AND'}
                  onChange={(blocks) => {
                    onUpdate({
                      ...condition,
                      value: '',
                      nested_group: {
                        type: 'group',
                        logic: condition.nested_group?.logic || 'AND',
                        children: blocks,
                      },
                    });
                  }}
                  readOnly={effectiveReadOnly}
                />
              </div>
            )}
          </>
        );
      
      case 'class': {
        const classNodes = selectedClassNode ? [selectedClassNode] : [];
        const operator = condition.operator || 'contains';
        const needsClassSelection = operator !== 'defined' && operator !== 'not_defined';
        
        return (
          <>
            <div className="prose-condition__inline">
              <span className="prose-condition__word">class</span>
              <Dropdown
                value={operator}
                onChange={(value) => onUpdate({ ...condition, operator: value as 'is' | 'is_not' | 'contains' | 'does_not_contain' | 'defined' | 'not_defined' })}
                disabled={effectiveReadOnly}
                options={[
                  { value: 'contains', label: 'contains' },
                  { value: 'does_not_contain', label: 'does not contain' },
                  { value: 'is', label: 'is' },
                  { value: 'is_not', label: 'is not' },
                  { value: 'defined', label: 'is defined' },
                  { value: 'not_defined', label: 'is not defined' },
                ]}
                size="sm"
              />
            </div>
            {needsClassSelection && (
              <SelectionButton
                value={classSelectionMode}
                onChange={(mode) => {
                  setClassSelectionMode(mode);
                    if (mode === 'static') {
                      // Switch back to class type, clear dynamic data
                      const classUuid = 'class_uuid' in condition ? condition.class_uuid : '';
                      const classId = 'class_id' in condition ? condition.class_id : undefined;
                      onUpdate({
                        condition_type: 'class',
                        operator: condition.operator,
                        class_uuid: classUuid,
                        class_id: classId,
                      } as ClassCondition);
                    } else {
                      // Switch to class_path type for dynamic mode
                      onUpdate({
                        condition_type: 'class_path',
                        operator: condition.operator,
                        nested_group: {                            type: 'group',                          logic: 'AND',
                          children: [],
                        },
                      } as any);
                    }
                  }}
                  options={[
                    { value: 'static', label: 'Static', icon: mdiCursorPointer },
                    { value: 'dynamic', label: 'Dynamic', icon: mdiTextBoxMultipleOutline },
                  ]}
                  size="sm"
                  disabled={effectiveReadOnly}
                  className="prose-condition__selection-button"
                />
            )}
            {needsClassSelection && classSelectionMode === 'static' && (
              <div className="prose-condition__inline">
                <NodePillRow
                  nodes={classNodes}
                  searchMode="classes"
                  emptyText="Select class"
                  searchPlaceholder="Search classes..."
                  onAdd={(node) => {
                    onUpdate({
                      ...condition,
                      class_id: node.id,
                      class_uuid: node.uuid,
                      nested_group: undefined,
                    } as any);
                  }}
                  onRemove={() => {
                    onUpdate({
                      ...condition,
                      class_id: undefined,
                      class_uuid: '',
                      nested_group: undefined,
                    } as any);
                  }}
                  readOnly={effectiveReadOnly}
                />
              </div>
            )}
            {needsClassSelection && classSelectionMode === 'dynamic' && (
              <div className="prose-condition__nested">
                <span className="prose-condition__word-muted">where</span>
                <QueryBlockList
                  blocks={(condition as any).nested_group?.children || []}
                  parentLogic={(condition as any).nested_group?.logic || 'AND'}
                  onChange={(blocks) => {
                    onUpdate({
                      ...condition,
                      class_id: undefined,
                      class_uuid: '',
                      nested_group: {
                        type: 'group',
                        logic: (condition as any).nested_group?.logic || 'AND',
                        children: blocks,
                      },
                    } as any);
                  }}
                  readOnly={effectiveReadOnly}
                />
              </div>
            )}
          </>
        );
      }
      
      case 'reference': {
        const operator = condition.operator || 'references';
        const needsSelection = operator !== 'has_references' && operator !== 'has_no_references';
        
        return (
          <>
            <div className="prose-condition__inline">
              <Dropdown
                value={operator}
                onChange={(value) => onUpdate({ ...condition, operator: value as 'references' | 'does_not_reference' | 'has_references' | 'has_no_references' })}
                disabled={effectiveReadOnly}
                options={[
                  { value: 'references', label: 'references' },
                  { value: 'does_not_reference', label: 'does not reference' },
                  { value: 'has_references', label: 'has any references' },
                  { value: 'has_no_references', label: 'has no references' },
                ]}
                size="sm"
              />
            </div>
            {needsSelection && (
              <SelectionButton
                value={refSelectionMode}
                onChange={(mode) => {
                  setRefSelectionMode(mode);
                    if (mode === 'static') {
                      // Switch back to reference type, preserve existing target if any
                      const targetUuid = 'target_uuid' in condition ? condition.target_uuid : '';
                      const targetId = 'target_id' in condition ? condition.target_id : undefined;
                      onUpdate({
                        condition_type: 'reference',
                        operator: condition.operator,
                        target_uuid: targetUuid,
                        target_id: targetId,
                      } as ReferenceCondition);
                    } else {
                      // Switch to reference_path type for dynamic mode
                      onUpdate({
                        condition_type: 'reference_path',
                        operator: condition.operator,
                        nested_group: {                            type: 'group',                          logic: 'AND',
                          children: [],
                        },
                      } as any);
                    }
                  }}
                  options={[
                    { value: 'static', label: 'Static', icon: mdiCursorPointer },
                    { value: 'dynamic', label: 'Dynamic', icon: mdiTextBoxMultipleOutline },
                  ]}
                  size="sm"
                  disabled={effectiveReadOnly}
                  className="prose-condition__selection-button"
                />
            )}
            {needsSelection && refSelectionMode === 'static' && (
              <div className="prose-condition__inline">
                <SingleNodeSelector
                  mode="pages"
                  selectedId={condition.target_id ?? null}
                  onChange={(nodeId, node) => {
                    onUpdate({
                      ...condition,
                      target_id: nodeId ?? undefined,
                      target_uuid: node?.uuid ?? '',
                      nested_group: undefined,
                    });
                  }}
                  placeholder="Select node..."
                  readOnly={effectiveReadOnly}
                />
              </div>
            )}
            {needsSelection && refSelectionMode === 'dynamic' && (
              <div className="prose-condition__nested">
                <span className="prose-condition__word-muted">where</span>
                <QueryBlockList
                  blocks={condition.nested_group?.children || []}
                  parentLogic={condition.nested_group?.logic || 'AND'}
                  onChange={(blocks) => {
                    onUpdate({
                      ...condition,
                      target_id: undefined,
                      target_uuid: '',
                      nested_group: {
                        type: 'group',
                        logic: condition.nested_group?.logic || 'AND',
                        children: blocks,
                      },
                    } as any);
                  }}
                  readOnly={effectiveReadOnly}
                />
              </div>
            )}
          </>
        );
      }

      case 'parent': {
        const operator = condition.operator || 'has_parent';
        const needsSelection = operator === 'has_parent';
        
        return (
          <>
            <div className="prose-condition__inline">
              <span className="prose-condition__word">parent</span>
              <Dropdown
                value={operator}
                onChange={(value) => onUpdate({ ...condition, operator: value as 'has_parent' | 'has_no_parent' })}
                disabled={effectiveReadOnly}
                options={[
                  { value: 'has_parent', label: 'is' },
                  { value: 'has_no_parent', label: 'is not set' },
                ]}
                size="sm"
              />
            </div>
            {needsSelection && (
              <SelectionButton
                value={parentSelectionMode}
                onChange={(mode) => {
                  setParentSelectionMode(mode);
                    if (mode === 'static') {
                      // Switch to static mode with parent_uuid
                      const parentUuid = 'parent_uuid' in condition ? condition.parent_uuid : '';
                      const parentId = 'parent_id' in condition ? condition.parent_id : undefined;
                      onUpdate({
                        condition_type: 'parent',
                        operator: condition.operator,
                        parent_uuid: parentUuid,
                        parent_id: parentId,
                      } as any);
                    } else {
                      // Switch to dynamic mode with nested_group
                      onUpdate({
                        condition_type: 'parent',
                        operator: condition.operator,
                        nested_group: {
                          type: 'group',
                          logic: 'AND',
                          children: [],
                        },
                      } as any);
                    }
                  }}
                  options={[
                    { value: 'static', label: 'Static', icon: mdiCursorPointer },
                    { value: 'dynamic', label: 'Dynamic', icon: mdiTextBoxMultipleOutline },
                  ]
                }
                size="sm"
                  disabled={effectiveReadOnly}
                  className="prose-condition__selection-button"
                />
            )}
            {needsSelection && parentSelectionMode === 'static' && (
              <div className="prose-condition__inline">
                <SingleNodeSelector
                  mode="pages"
                  selectedId={
                    condition.parent_uuid === '{current_node_uuid}' ? -1 : 
                    condition.parent_id ?? null
                  }
                  onChange={(nodeId, node) => {
                    if (nodeId === -1) {
                      // Current Page selected
                      onUpdate({
                        ...condition,
                        parent_uuid: '{current_node_uuid}',
                        parent_id: undefined,
                        nested_group: undefined,
                      } as any);
                    } else {
                      onUpdate({
                        ...condition,
                        parent_uuid: node?.uuid ?? '',
                        parent_id: nodeId ?? undefined,
                        nested_group: undefined,
                      } as any);
                    }
                  }}
                  placeholder="Select parent..."
                  readOnly={effectiveReadOnly}
                />
              </div>
            )}
            {needsSelection && parentSelectionMode === 'dynamic' && (
              <div className="prose-condition__nested">
                <span className="prose-condition__word-muted">where</span>
                <QueryBlockList
                  blocks={(condition as any).nested_group?.children || []}
                  parentLogic={(condition as any).nested_group?.logic || 'AND'}
                  onChange={(blocks) => {
                    onUpdate({
                      ...condition,
                      parent_id: undefined,
                      parent_uuid: '',
                      nested_group: {
                        type: 'group',
                        logic: (condition as any).nested_group?.logic || 'AND',
                        children: blocks,
                      },
                    } as any);
                  }}
                  readOnly={effectiveReadOnly}
                />
              </div>
            )}
          </>
        );
      }

      default: {
        // Handle nested group conditions (parent, child, reference_path, etc.)
        if (usesNestedGroup(condition.condition_type)) {
          return (
            <div className="prose-condition__inline">
              <span className="prose-condition__text">{renderConditionProse(condition)}</span>
            </div>
          );
        }
        
        // Fallback for unknown condition types
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__text">{renderConditionProse(condition)}</span>
          </div>
        );
      }
    }
  };
  
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
      
      {/* Condition content */}
      {renderCondition()}
    </div>
  );
}

export default ProseConditionBuilder;
