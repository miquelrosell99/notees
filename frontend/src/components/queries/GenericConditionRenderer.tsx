/**
 * GenericConditionRenderer
 * 
 * Config-driven condition renderer that eliminates repetitive switch statements.
 * Uses ConditionConfig to determine how to render each condition type.
 */

import { useState, useEffect } from 'react';
import { mdiCursorPointer, mdiTextBoxMultipleOutline } from '@mdi/js';
import { Dropdown } from '../core/Dropdown';
import { TextField } from '../core/TextField';
import { SelectionButton } from '../core/SelectionButton';
import { NodePillRow } from '../NodePillRow';
import { SingleNodeSelector } from './NodeSelectors';
import { QueryBlockList } from './QueryBlockList';
import { useNode, useProperties } from '@/hooks';
import type { ConditionNode, GroupNode } from '@/types/queryAST';
import { 
  getConditionConfig, 
  operatorNeedsValue, 
  alwaysUsesNestedGroup 
} from './conditionConfigs';

// ==================== Types ====================

interface GenericConditionRendererProps {
  condition: ConditionNode;
  onUpdate: (condition: ConditionNode) => void;
  readOnly?: boolean;
}

// ==================== Main Component ====================

export function GenericConditionRenderer({
  condition,
  onUpdate,
  readOnly = false,
}: GenericConditionRendererProps) {
  
  const config = getConditionConfig(condition.condition_type);
  
  if (!config) {
    // Fallback for unknown condition types
    return (
      <div className="prose-condition__inline">
        <span className="prose-condition__text">
          Unknown condition type: {condition.condition_type}
        </span>
      </div>
    );
  }
  
  // Determine if we're in dynamic mode
  const hasDynamicMode = config.hasStaticDynamicToggle || alwaysUsesNestedGroup(condition.condition_type);
  const inDynamicMode = 'nested_group' in condition && condition.nested_group !== undefined;
  
  // State for static/dynamic toggle
  const [selectionMode, setSelectionMode] = useState<'static' | 'dynamic'>(
    inDynamicMode ? 'dynamic' : 'static'
  );
  
  // Get current operator
  const operator = (condition as any).operator || config.defaultOperator;
  const needsValue = operatorNeedsValue(condition.condition_type, operator);
  
  // Hooks for data fetching (always call, conditionally use)
  const { data: allProperties = [] } = useProperties();
  const classId = condition.condition_type === 'class' ? (condition as any).class_id : null;
  const { data: selectedClassNode } = useNode(classId);
  
  // Update selection mode when condition changes externally
  useEffect(() => {
    const hasNested = 'nested_group' in condition && condition.nested_group !== undefined;
    if (hasNested !== (selectionMode === 'dynamic')) {
      setSelectionMode(hasNested ? 'dynamic' : 'static');
    }
  }, [condition, selectionMode]);
  
  // Handler for operator change
  const handleOperatorChange = (newOperator: string | null) => {
    if (!newOperator) return;
    onUpdate({
      ...condition,
      operator: newOperator,
    } as any);
  };
  
  // Handler for static/dynamic toggle
  const handleModeChange = (mode: string) => {
    setSelectionMode(mode as 'static' | 'dynamic');
    
    if (mode === 'static') {
      // Switch to static mode - remove nested_group
      const updated = { ...condition };
      delete (updated as any).nested_group;
      onUpdate(updated);
    } else {
      // Switch to dynamic mode - add nested_group
      onUpdate({
        ...condition,
        nested_group: {
          type: 'group',
          logic: config.dynamicMode?.defaultLogic || 'AND',
          children: [],
        },
      } as any);
    }
  };
  
  // Handler for value changes
  const handleValueChange = (value: any) => {
    onUpdate({
      ...condition,
      ...(condition.condition_type === 'content' ? { value } : {}),
      ...(condition.condition_type === 'property' ? { value } : {}),
    } as any);
  };
  
  // Handler for node selection
  const handleNodeSelect = (nodeId: number | null, node?: any) => {
    const updates: any = {};
    
    if (condition.condition_type === 'class') {
      updates.class_id = nodeId ?? undefined;
      updates.class_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'reference') {
      updates.target_id = nodeId ?? undefined;
      updates.target_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'parent') {
      updates.parent_id = nodeId ?? undefined;
      updates.parent_uuid = node?.uuid ?? '';
    }
    
    onUpdate({
      ...condition,
      ...updates,
      nested_group: undefined, // Clear nested group when selecting static value
    } as any);
  };
  
  // Handler for nested group changes
  const handleNestedGroupChange = (children: Array<ConditionNode | GroupNode | any>) => {
    const nestedGroup = (condition as any).nested_group;
    if (nestedGroup) {
      onUpdate({
        ...condition,
        nested_group: {
          ...nestedGroup,
          children,
        },
      } as any);
    }
  };
  
  // Render operator dropdown
  const renderOperator = () => (
    <Dropdown
      value={operator}
      onChange={handleOperatorChange}
      disabled={readOnly}
      options={config.operators}
      size="sm"
    />
  );
  
  // Render static/dynamic toggle
  const renderModeToggle = () => {
    if (!hasDynamicMode || !needsValue || readOnly) return null;
    
    return (
      <SelectionButton
        value={selectionMode}
        onChange={handleModeChange}
        options={[
          { value: 'static', label: 'Static', icon: mdiCursorPointer },
          { value: 'dynamic', label: 'Dynamic', icon: mdiTextBoxMultipleOutline },
        ]}
        size="sm"
        disabled={readOnly}
        className="prose-condition__selection-button"
      />
    );
  };
  
  // Render static value input
  const renderStaticInput = () => {
    if (!needsValue || selectionMode === 'dynamic') return null;
    
    switch (config.staticMode.inputType) {
      case 'text':
        const value = (condition as any).value ?? '';
        const isEmpty = value === '' || value === null || value === undefined;
        const showError = isEmpty && config.staticMode.required && !readOnly;
        
        return (
          <TextField
            value={String(value)}
            onChange={(e) => handleValueChange(e.target.value)}
            placeholder={config.staticMode.placeholder}
            disabled={readOnly}
            size="sm"
            className={`prose-condition__input ${showError ? 'prose-condition__input--error' : ''}`}
          />
        );
      
      case 'node-selector':
        const selectedId = (condition as any).target_id || (condition as any).parent_id || null;
        return (
          <SingleNodeSelector
            mode="pages"
            selectedId={selectedId}
            onChange={handleNodeSelect}
            placeholder={config.staticMode.placeholder}
            readOnly={readOnly}
          />
        );
      
      case 'class-selector':
        const classNodes = selectedClassNode ? [selectedClassNode] : [];
        return (
          <NodePillRow
            nodes={classNodes}
            searchMode="classes"
            emptyText={config.staticMode.placeholder}
            searchPlaceholder="Search classes..."
            onAdd={(node) => handleNodeSelect(node.id, node)}
            onRemove={() => handleNodeSelect(null)}
            readOnly={readOnly}
          />
        );
      
      case 'property-selector':
        // Special handling for property condition
        if (condition.condition_type === 'property') {
          const propertyName = (condition as any).property_name || '';
          const builtInProps = [
            { value: 'uuid', label: 'uuid' },
            { value: 'id', label: 'id' },
          ];
          const customProps = allProperties.map(p => ({ value: p.name, label: p.name }));
          const allProps = [...builtInProps, ...customProps];
          
          return (
            <Dropdown
              value={propertyName}
              onChange={(value) => onUpdate({ ...condition, property_name: value || '' } as any)}
              options={allProps}
              placeholder="Select property"
              disabled={readOnly}
              size="sm"
              className="prose-condition__input"
            />
          );
        }
        return null;
      
      case 'none':
        return null;
      
      default:
        return null;
    }
  };
  
  // Render dynamic nested group
  const renderNestedGroup = () => {
    if (selectionMode === 'static' && !alwaysUsesNestedGroup(condition.condition_type)) {
      return null;
    }
    
    const nestedGroup = (condition as any).nested_group;
    if (!nestedGroup) return null;
    
    return (
      <div className="prose-condition__nested">
        <span className="prose-condition__word-muted">
          {config.dynamicMode?.whereLabel || 'where'}
        </span>
        <QueryBlockList
          blocks={nestedGroup.children}
          parentLogic={nestedGroup.logic}
          onChange={handleNestedGroupChange}
          readOnly={readOnly}
        />
      </div>
    );
  };
  
  // Main render
  return (
    <>
      <div className="prose-condition__inline">
        <span className="prose-condition__word">{config.label}</span>
        {renderOperator()}
        {renderModeToggle()}
        {renderStaticInput()}
      </div>
      {renderNestedGroup()}
    </>
  );
}

export default GenericConditionRenderer;
