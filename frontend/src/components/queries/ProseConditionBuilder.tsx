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

import { useCallback, useState } from 'react';
import { mdiClose, mdiCursorPointer, mdiTextBoxMultipleOutline } from '@mdi/js';
import Icon from '@mdi/react';
import { Button } from '../core/Button';
import { Dropdown } from '../core/Dropdown';
import { TextField } from '../core/TextField';
import { SelectionButton } from '../core/SelectionButton';
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
