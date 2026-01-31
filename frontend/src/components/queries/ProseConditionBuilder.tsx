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
import { mdiClose, mdiCursorPointer, mdiTextBoxMultipleOutline } from '@mdi/js';
import Icon from '@mdi/react';
import { Button } from '../core/Button';
import { Dropdown } from '../core/Dropdown';
import { TextField } from '../core/TextField';
import { SelectionButton } from '../core/SelectionButton';
import { NodePillRow } from '../NodePillRow';
import { SingleNodeSelector } from './NodeSelectors';
import { useNode, useProperties } from '@/hooks';
import { renderConditionProse } from '@/lib/astProseRenderer';
import { isSystemNode, isNodeEditable, isNodeRemovable } from '@/types/queryAST';
import type { ConditionNode, ContentOperator, PropertyOperator } from '@/types/queryAST';
import './ProseConditionBuilder.css';

// ==================== Helpers ====================

/**
 * Check if a condition type handles node selection
 */
function handlesNodeSelection(conditionType: string): boolean {
  return ['class', 'reference'].includes(conditionType);
}

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
  onRemove,
  readOnly = false,
}: ProseConditionBuilderProps) {
  
  // Safety check - if block is undefined, render nothing
  if (!block) {
    console.error('ProseConditionBuilder: block is undefined');
    return null;
  }
  
  const condition = block;
  const isSystem = isSystemNode(condition);
  const isEditable = !readOnly && isNodeEditable(condition);
  const isRemovable = !readOnly && isNodeRemovable(condition);
  
  return (
    <ProseConditionRow
      condition={condition}
      onUpdate={onChange}
      onDelete={onRemove}
      readOnly={!isEditable}
      canDelete={isRemovable}
    />
  );
}

// ==================== Prose Condition Row ====================

interface ProseConditionRowProps {
  condition: ConditionNode;
  onUpdate: (condition: ConditionNode) => void;
  onDelete: () => void;
  readOnly?: boolean;
  canDelete?: boolean;
}

function ProseConditionRow({
  condition,
  onUpdate,
  onDelete,
  readOnly = false,
  canDelete = true,
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
        const { data: allProperties = [] } = useProperties();
        
        // Built-in properties that are always available
        const builtInProperties = [
          { value: 'uuid', label: 'uuid' },
          { value: 'name', label: 'name' },
          { value: 'id', label: 'id' },
          { value: 'parent_id', label: 'parent_id' },
          { value: 'is_page', label: 'is_page' },
          { value: 'is_favorite', label: 'is_favorite' },
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
        
        // For node properties, support static/dynamic mode
        const isDynamicMode = condition.value_uuids && condition.value_uuids.length > 0;
        const [propSelectionMode, setPropSelectionMode] = useState(isDynamicMode ? 'dynamic' : 'static');
        
        return (
          <div className="prose-condition__inline">
            <span className="prose-condition__word">property</span>
            <Dropdown
              value={condition.property_name}
              onChange={(value) => onUpdate({ ...condition, property_name: value })}
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
            {showValue && isNodeProperty && (
              <>
                <SelectionButton
                  value={propSelectionMode}
                  onChange={(mode) => {
                    setPropSelectionMode(mode);
                    if (mode === 'static') {
                      onUpdate({
                        ...condition,
                        value_uuids: undefined,
                      });
                    } else {
                      const initialUuids = condition.value ? [String(condition.value)] : [];
                      onUpdate({
                        ...condition,
                        value: initialUuids[0] || '',
                        value_uuids: initialUuids,
                      });
                    }
                  }}
                  options={[
                    { value: 'static', label: 'Static', icon: mdiCursorPointer },
                    { value: 'dynamic', label: 'Dynamic', icon: mdiTextBoxMultipleOutline },
                  ]}
                  size="sm"
                  disabled={effectiveReadOnly}
                />
                {propSelectionMode === 'static' ? (
                  <SingleNodeSelector
                    mode="all"
                    selectedId={null}
                    onChange={(nodeId, node) => {
                      onUpdate({
                        ...condition,
                        value: node?.uuid ?? '',
                        value_uuids: undefined,
                      });
                    }}
                    placeholder="Select node..."
                    readOnly={effectiveReadOnly}
                  />
                ) : (
                  <TextField
                    value={(condition.value_uuids || []).join(', ')}
                    onChange={(e) => {
                      const uuids = (e.target.value as string)
                        .split(',')
                        .map((s: string) => s.trim())
                        .filter((s: string) => s.length > 0);
                      onUpdate({
                        ...condition,
                        value: uuids[0] || '',
                        value_uuids: uuids,
                      });
                    }}
                    placeholder="Enter node UUIDs separated by commas"
                    disabled={effectiveReadOnly}
                    size="sm"
                    className="prose-condition__input"
                  />
                )}
              </>
            )}
            {showValue && !isNodeProperty && (
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
      
      case 'class': {
        const { data: selectedClass } = useNode(condition.class_id || null);
        const classNodes = selectedClass ? [selectedClass] : [];
        const operator = condition.operator || 'contains';
        const needsClassSelection = operator !== 'defined' && operator !== 'not_defined';
        
        // Determine if using dynamic mode (comma-separated UUIDs)
        const isDynamicMode = condition.class_uuids && condition.class_uuids.length > 0;
        const [selectionMode, setSelectionMode] = useState(isDynamicMode ? 'dynamic' : 'static');
        
        return (
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
            {needsClassSelection && (
              <>
                <SelectionButton
                  value={selectionMode}
                  onChange={(mode) => {
                    setSelectionMode(mode);
                    if (mode === 'static') {
                      // Clear dynamic data, keep current static selection
                      onUpdate({
                        ...condition,
                        class_uuids: undefined,
                      });
                    } else {
                      // Clear static data, initialize dynamic with current selection
                      const initialUuids = condition.class_uuid ? [condition.class_uuid] : [];
                      onUpdate({
                        ...condition,
                        class_id: undefined,
                        class_uuid: initialUuids.length > 0 ? initialUuids[0] : '',
                        class_uuids: initialUuids,
                      });
                    }
                  }}
                  options={[
                    { value: 'static', label: 'Static', icon: mdiCursorPointer },
                    { value: 'dynamic', label: 'Dynamic', icon: mdiTextBoxMultipleOutline },
                  ]}
                  size="sm"
                  disabled={effectiveReadOnly}
                />
                {selectionMode === 'static' ? (
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
                        class_uuids: undefined,
                      });
                    }}
                    onRemove={() => {
                      onUpdate({
                        ...condition,
                        class_id: undefined,
                        class_uuid: '',
                        class_uuids: undefined,
                      });
                    }}
                    readOnly={effectiveReadOnly}
                  />
                ) : (
                  <TextField
                    value={(condition.class_uuids || []).join(', ')}
                    onChange={(value) => {
                      const uuids = (value as string)
                        .split(',')
                        .map((s: string) => s.trim())
                        .filter((s: string) => s.length > 0);
                      onUpdate({
                        ...condition,
                        class_id: undefined,
                        class_uuid: uuids[0] || '',
                        class_uuids: uuids,
                      });
                    }}
                    placeholder="Enter class UUIDs separated by commas"
                    size="sm"
                    readOnly={effectiveReadOnly}
                  />
                )}
              </>
            )}
          </div>
        );
      }
      
      case 'reference': {
        const operator = condition.operator || 'references';
        const needsSelection = operator !== 'has_references' && operator !== 'has_no_references';
        
        // Determine if using dynamic mode (comma-separated UUIDs)
        const isDynamicMode = condition.target_uuids && condition.target_uuids.length > 0;
        const [selectionMode, setSelectionMode] = useState(isDynamicMode ? 'dynamic' : 'static');
        
        return (
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
            {needsSelection && (
              <>
                <SelectionButton
                  value={selectionMode}
                  onChange={(mode) => {
                    setSelectionMode(mode);
                    if (mode === 'static') {
                      // Clear dynamic data, keep current static selection
                      onUpdate({
                        ...condition,
                        target_uuids: undefined,
                      });
                    } else {
                      // Clear static data, initialize dynamic with current selection
                      const initialUuids = condition.target_uuid ? [condition.target_uuid] : [];
                      onUpdate({
                        ...condition,
                        target_id: undefined,
                        target_uuid: initialUuids.length > 0 ? initialUuids[0] : '',
                        target_uuids: initialUuids,
                      });
                    }
                  }}
                  options={[
                    { value: 'static', label: 'Static', icon: mdiCursorPointer },
                    { value: 'dynamic', label: 'Dynamic', icon: mdiTextBoxMultipleOutline },
                  ]}
                  size="sm"
                  disabled={effectiveReadOnly}
                />
                {selectionMode === 'static' ? (
                  <SingleNodeSelector
                    mode="pages"
                    selectedId={condition.target_id ?? null}
                    onChange={(nodeId, node) => {
                      onUpdate({
                        ...condition,
                        target_id: nodeId ?? undefined,
                        target_uuid: node?.uuid ?? '',
                        target_uuids: undefined,
                      });
                    }}
                    placeholder="Select node..."
                    readOnly={effectiveReadOnly}
                  />
                ) : (
                  <TextField
                    value={(condition.target_uuids || []).join(', ')}
                    onChange={(value) => {
                      const uuids = (value as string)
                        .split(',')
                        .map((s: string) => s.trim())
                        .filter((s: string) => s.length > 0);
                      onUpdate({
                        ...condition,
                        target_id: undefined,
                        target_uuid: uuids[0] || '',
                        target_uuids: uuids,
                      });
                    }}
                    placeholder="Enter node UUIDs separated by commas"
                    size="sm"
                    readOnly={effectiveReadOnly}
                  />
                )}
              </>
            )}
          </div>
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
      
      {/* Delete button */}
      {!readOnly && isRemovable && canDelete && (
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

export default ProseConditionBuilder;
