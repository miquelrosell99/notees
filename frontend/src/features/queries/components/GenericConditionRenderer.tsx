/**
 * GenericConditionRenderer
 * 
 * Config-driven condition renderer that eliminates repetitive switch statements.
 * Uses ConditionConfig to determine how to render each condition type.
 */

import { useState, useEffect } from 'react';
import { Dropdown } from '@/components/ui/Dropdown';
import { TextField } from '@/components/ui/TextField';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { NodeSelector } from '@/features/content';

import { useProperties } from '@/features/properties';
import { useNodeByUuid } from '@/features/content';
import { useCurrentNodeUuid } from '@/features/content';
import type { ConditionNode, StyleType } from '@/types/queryAST';
import type { Node } from '@/types';
import { 
  getConditionConfig, 
  operatorNeedsValue, 
  alwaysUsesNestedGroup 
} from './conditionConfigs';
import './GenericConditionRenderer.css';

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
  const currentNodeUuid = useCurrentNodeUuid();
  
  // Extract the class UUID for class/extends conditions.
  const classUuid = condition.condition_type === 'class'
    ? (condition as unknown as Record<string, unknown>).class_uuid as string | null
    : condition.condition_type === 'extends'
      ? (condition as unknown as Record<string, unknown>).extends_class_uuid as string | null
      : null;
  // Filter out placeholder UUIDs that shouldn't be fetched
  const classUuidForFetch = classUuid && classUuid !== '{current_node_uuid}' ? classUuid : null;

  // Hooks must be called unconditionally - always call them here
  const { data: allProperties = [] } = useProperties();
  const { data: selectedClassNode } = useNodeByUuid(classUuidForFetch);
  
  // Determine if we're in dynamic mode
  const hasDynamicMode = config?.hasStaticDynamicToggle || alwaysUsesNestedGroup(condition.condition_type);
  const inDynamicMode = 'nested_group' in condition && condition.nested_group !== undefined;
  
  // Check if using current node - either explicit placeholder OR actual UUID match
  const hasCurrentNodePlaceholder = (() => {
    if (condition.condition_type === 'parent') {
      const uuid = (condition as unknown as Record<string, unknown>).parent_uuid;
      return uuid === '{current_node_uuid}' || (uuid && uuid === currentNodeUuid);
    } else if (condition.condition_type === 'reference') {
      const uuid = (condition as unknown as Record<string, unknown>).target_uuid;
      return uuid === '{current_node_uuid}' || (uuid && uuid === currentNodeUuid);
    } else if (condition.condition_type === 'reference_path') {
      const uuids = (condition as unknown as Record<string, unknown>).target_uuids as string[] | undefined;
      return uuids?.length === 1 && (uuids[0] === '{current_node_uuid}' || uuids[0] === currentNodeUuid);
    } else if (condition.condition_type === 'parent_path') {
      const uuids = (condition as unknown as Record<string, unknown>).ancestor_uuids as string[] | undefined;
      return uuids?.length === 1 && (uuids[0] === '{current_node_uuid}' || uuids[0] === currentNodeUuid);
    } else if (condition.condition_type === 'child_path') {
      const uuids = (condition as unknown as Record<string, unknown>).descendant_uuids as string[] | undefined;
      return uuids?.length === 1 && (uuids[0] === '{current_node_uuid}' || uuids[0] === currentNodeUuid);
    } else if (condition.condition_type === 'property') {
      const value = (condition as unknown as Record<string, unknown>).value;
      return value === '{current_node_uuid}' || (value && value === currentNodeUuid);
    } else if (condition.condition_type === 'class') {
      const uuid = (condition as unknown as Record<string, unknown>).class_uuid;
      return uuid === '{current_node_uuid}' || (uuid && uuid === currentNodeUuid);
    } else if (condition.condition_type === 'extends') {
      const uuid = (condition as unknown as Record<string, unknown>).extends_class_uuid;
      return uuid === '{current_node_uuid}' || (uuid && uuid === currentNodeUuid);
    } else if (condition.condition_type === 'page') {
      const uuid = (condition as unknown as Record<string, unknown>).page_uuid;
      return uuid === '{current_node_uuid}' || (uuid && uuid === currentNodeUuid);
    } else if (condition.condition_type === 'tag') {
      const uuids = (condition as unknown as Record<string, unknown>).tag_uuids as string[] | undefined;
      return uuids?.length === 1 && (uuids[0] === '{current_node_uuid}' || uuids[0] === currentNodeUuid);
    }
    return false;
  })();
  
  // State for static/dynamic/current toggle
  const [selectionMode, setSelectionMode] = useState<'static' | 'current' | 'dynamic'>(
    inDynamicMode ? 'dynamic' : hasCurrentNodePlaceholder ? 'current' : 'static'
  );
  
  // Get current operator
  const operator = (condition as unknown as Record<string, unknown>).operator as string | undefined || config?.defaultOperator;
  const needsValue = operatorNeedsValue(condition.condition_type, operator as string);
  
  // Update selection mode when condition changes externally
  useEffect(() => {
    const hasNested = 'nested_group' in condition && condition.nested_group !== undefined;
    const hasCurrent = (() => {
      if (condition.condition_type === 'parent') {
        const uuid = (condition as unknown as Record<string, unknown>).parent_uuid;
        return uuid === '{current_node_uuid}' || (uuid && uuid === currentNodeUuid);
      } else if (condition.condition_type === 'reference') {
        const uuid = (condition as unknown as Record<string, unknown>).target_uuid;
        return uuid === '{current_node_uuid}' || (uuid && uuid === currentNodeUuid);
      } else if (condition.condition_type === 'reference_path') {
        const uuids = (condition as unknown as Record<string, unknown>).target_uuids as string[] | undefined;
        return uuids?.length === 1 && (uuids[0] === '{current_node_uuid}' || uuids[0] === currentNodeUuid);
      } else if (condition.condition_type === 'parent_path') {
        const uuids = (condition as unknown as Record<string, unknown>).ancestor_uuids as string[] | undefined;
        return uuids?.length === 1 && (uuids[0] === '{current_node_uuid}' || uuids[0] === currentNodeUuid);
      } else if (condition.condition_type === 'child_path') {
        const uuids = (condition as unknown as Record<string, unknown>).descendant_uuids as string[] | undefined;
        return uuids?.length === 1 && (uuids[0] === '{current_node_uuid}' || uuids[0] === currentNodeUuid);
      } else if (condition.condition_type === 'property') {
        const value = (condition as unknown as Record<string, unknown>).value;
        return value === '{current_node_uuid}' || (value && value === currentNodeUuid);
      } else if (condition.condition_type === 'class') {
        const uuid = (condition as unknown as Record<string, unknown>).class_uuid;
        return uuid === '{current_node_uuid}' || (uuid && uuid === currentNodeUuid);
      } else if (condition.condition_type === 'extends') {
        const uuid = (condition as unknown as Record<string, unknown>).extends_class_uuid;
        return uuid === '{current_node_uuid}' || (uuid && uuid === currentNodeUuid);
      } else if (condition.condition_type === 'page') {
        const uuid = (condition as unknown as Record<string, unknown>).page_uuid;
        return uuid === '{current_node_uuid}' || (uuid && uuid === currentNodeUuid);
      } else if (condition.condition_type === 'tag') {
        const uuids = (condition as unknown as Record<string, unknown>).tag_uuids as string[] | undefined;
        return uuids?.length === 1 && (uuids[0] === '{current_node_uuid}' || uuids[0] === currentNodeUuid);
      }
      return false;
    })();
    
    const expectedMode = hasNested ? 'dynamic' : hasCurrent ? 'current' : 'static';
    if (selectionMode !== expectedMode) {
       
      setSelectionMode(expectedMode);
    }
  }, [condition, selectionMode, currentNodeUuid]);
  
  // NOW we can do conditional checks after all hooks are called
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
  
  // Handler for operator change
  const handleOperatorChange = (newOperator: string | null) => {
    if (!newOperator) return;
    
    const updated: Record<string, unknown> = {
      ...condition,
      operator: newOperator,
    };
    
    // If switching to a noValueOperator, clear nested_group and static values
    if (!operatorNeedsValue(condition.condition_type, newOperator)) {
      delete updated.nested_group;
      
      // Clear static mode values
      if (condition.condition_type === 'parent') {
        delete updated.parent_uuid;
        delete updated.parent_uuids;
      } else if (condition.condition_type === 'child') {
        delete updated.child_uuids;
      } else if (condition.condition_type === 'page') {
        delete updated.page_uuid;
        delete updated.page_uuids;
      } else if (condition.condition_type === 'tag') {
        delete updated.tag_uuid;
        delete updated.tag_uuids;
      }
      
      // Reset to static mode
      setSelectionMode('static');
    }
    
    onUpdate(updated as unknown as ConditionNode);
  };
  
  // Handler for static/dynamic/current toggle
  const handleModeChange = (mode: string) => {
    setSelectionMode(mode as 'static' | 'current' | 'dynamic');
    
    if (mode === 'static') {
      // Switch to static mode - remove nested_group and clear placeholder
      const updated: Record<string, unknown> = { ...condition };
      delete updated.nested_group;
      
      // Clear current node placeholder if present
      if (condition.condition_type === 'parent') {
        delete updated.parent_uuid;
      } else if (condition.condition_type === 'reference') {
        delete updated.target_uuid;
      } else if (condition.condition_type === 'reference_path') {
        updated.target_uuids = [];
      } else if (condition.condition_type === 'parent_path') {
        updated.ancestor_uuids = [];
      } else if (condition.condition_type === 'child_path') {
        updated.descendant_uuids = [];
      } else if (condition.condition_type === 'property') {
        updated.value = '';
      } else if (condition.condition_type === 'page') {
        delete updated.page_uuid;
      }
      
      onUpdate(updated as unknown as ConditionNode);
    } else if (mode === 'current') {
      // Switch to current node mode - remove nested_group and set to current node UUID
      const updated: Record<string, unknown> = { ...condition };
      delete updated.nested_group;
      
      // Use actual UUID if available, otherwise use placeholder
      const targetUuid = currentNodeUuid || '{current_node_uuid}';
      
      if (condition.condition_type === 'parent') {
        updated.parent_uuid = targetUuid;
      } else if (condition.condition_type === 'reference') {
        updated.target_uuid = targetUuid;
      } else if (condition.condition_type === 'reference_path') {
        updated.target_uuids = [targetUuid];
      } else if (condition.condition_type === 'parent_path') {
        updated.ancestor_uuids = [targetUuid];
      } else if (condition.condition_type === 'child_path') {
        updated.descendant_uuids = [targetUuid];
      } else if (condition.condition_type === 'property') {
        updated.value = targetUuid;
      } else if (condition.condition_type === 'class') {
        updated.class_uuid = targetUuid;
      } else if (condition.condition_type === 'extends') {
        updated.extends_class_uuid = targetUuid;
      } else if (condition.condition_type === 'page') {
        updated.page_uuid = targetUuid;
      }
      
      onUpdate(updated as unknown as ConditionNode);
    } else {
      // Switch to dynamic mode - add nested_group
      onUpdate({
        ...condition,
        nested_group: {
          type: 'group',
          logic: config.dynamicMode?.defaultLogic || 'AND',
          children: [],
        },
      } as unknown as ConditionNode);
    }
  };
  
  // Handler for value changes
  const handleValueChange = (value: unknown) => {
    onUpdate({
      ...condition,
      ...(condition.condition_type === 'content' ? { value } : {}),
      ...(condition.condition_type === 'property' ? { value } : {}),
    } as unknown as ConditionNode);
  };
  
  // Handler for node selection
  const handleNodeSelect = (_nodeUuid: string | null, node?: Node) => {
    const updates: Record<string, unknown> = {};
    
    if (condition.condition_type === 'class') {
      updates.class_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'reference') {
      updates.target_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'reference_path') {
      // Multi-select: append to target_uuids array
      const existing = condition as unknown as Record<string, unknown>;
      if (node?.uuid) {
        const currentUuids = (existing.target_uuids as string[]) || [];
        if (!currentUuids.includes(node.uuid)) {
          updates.target_uuids = [...currentUuids, node.uuid];
        }
      } else {
        updates.target_uuids = [];
      }
    } else if (condition.condition_type === 'parent_path') {
      // Multi-select: append to ancestor_uuids array
      const existing = condition as unknown as Record<string, unknown>;
      if (node?.uuid) {
        const currentUuids = (existing.ancestor_uuids as string[]) || [];
        if (!currentUuids.includes(node.uuid)) {
          updates.ancestor_uuids = [...currentUuids, node.uuid];
        }
      } else {
        updates.ancestor_uuids = [];
      }
    } else if (condition.condition_type === 'child_path') {
      // Multi-select: append to descendant_uuids array
      const existing = condition as unknown as Record<string, unknown>;
      if (node?.uuid) {
        const currentUuids = (existing.descendant_uuids as string[]) || [];
        if (!currentUuids.includes(node.uuid)) {
          updates.descendant_uuids = [...currentUuids, node.uuid];
        }
      } else {
        updates.descendant_uuids = [];
      }
    } else if (condition.condition_type === 'parent') {
      updates.parent_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'extends') {
      updates.extends_class_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'page') {
      updates.page_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'tag') {
      const existing = condition as unknown as Record<string, unknown>;
      if (node?.uuid) {
        const currentUuids = (existing.tag_uuids as string[]) || [];
        if (!currentUuids.includes(node.uuid)) {
          updates.tag_uuids = [...currentUuids, node.uuid];
        }
      } else {
        updates.tag_uuids = [];
      }
    }

    onUpdate({
      ...condition,
      ...updates,
      nested_group: undefined, // Clear nested group when selecting static value
    } as unknown as ConditionNode);
  };
  
  // Render operator dropdown
  const renderOperator = () => (
    <Dropdown
      value={operator}
      onChange={handleOperatorChange}
      disabled={readOnly}
      options={config.operators}
      size="sm"
      className="prose-condition__operator"
    />
  );
  
  // Render static/dynamic/current toggle
  const renderModeToggle = () => {
    // Hide toggle if operator doesn't need a value
    if (!hasDynamicMode || !needsValue) return null;
    
    return (
      <SelectionButton
        value={selectionMode}
        onChange={handleModeChange}
        options={[
          { value: 'static', label: 'Static', icon: "mdi mdi-cursor-pointer" },
          { value: 'current', label: 'Current Node', icon: "mdi mdi-crosshairs-gps" },
          { value: 'dynamic', label: 'Dynamic', icon: "mdi mdi-text-box-multiple-outline" },
        ]}
        size="sm"
        disabled={readOnly}
        className="prose-condition__selection-button"
      />
    );
  };
  
  const DATE_COLUMNS = ['create_date', 'write_date', 'open_date'];

  const isDateCondition = (): boolean => {
    if (condition.condition_type !== 'property') return false;
    const propCondition = condition as unknown as Record<string, unknown>;
    return propCondition.property_type === 'date' || DATE_COLUMNS.includes(propCondition.property_name as string);
  };

  const handleDateChip = (_label: string, operator: string, value: string) => {
    onUpdate({
      ...condition,
      operator,
      value,
    } as unknown as ConditionNode);
  };

  const renderDateChips = () => {
    if (!isDateCondition() || !needsValue || selectionMode !== 'static') return null;

    const chips = [
      { label: 'today', operator: 'gte', value: '{today}' },
      { label: 'this week', operator: 'gte', value: '{this_week}' },
      { label: 'this month', operator: 'gte', value: '{this_month}' },
      { label: 'this year', operator: 'gte', value: '{this_year}' },
      { label: 'before today', operator: 'lte', value: '{today}' },
    ];

    return (
      <div className="prose-condition__date-chips">
        {chips.map((chip) => (
          <button
            key={chip.label}
            type="button"
            onClick={() => handleDateChip(chip.label, chip.operator, chip.value)}
            disabled={readOnly}
            className="prose-condition__date-chip"
          >
            {chip.label}
          </button>
        ))}
      </div>
    );
  };

  // Render static value input
  const renderStaticInput = () => {
    if (!needsValue || selectionMode === 'dynamic') return null;

    // Show "Current Page" indicator when in current mode
    if (selectionMode === 'current') {
      return (
        <span className="prose-condition__current-node">
          Current Page
        </span>
      );
    }

    switch (config.staticMode.inputType) {
      case 'text': {
        const value = (condition as unknown as Record<string, unknown>).value ?? '';
        const isEmpty = value === '' || value === null || value === undefined;
        const showError = isEmpty && config.staticMode.required && !readOnly;

        return (
          <TextField
            value={String(value)}
            onChange={(e) => handleValueChange(e.target.value)}
            placeholder={isDateCondition() ? 'date or placeholder...' : config.staticMode.placeholder}
            disabled={readOnly}
            size="sm"
            className={`prose-condition__input ${showError ? 'prose-condition__input--error' : ''}`}
          />
        );
      }
      
      case 'node-selector': {
        // Path conditions use plural arrays (target_uuids, ancestor_uuids, descendant_uuids)
        // Tag condition also uses plural arrays.
        const isPathCondition = ['reference_path', 'parent_path', 'child_path', 'tag'].includes(condition.condition_type);
        
        if (isPathCondition) {
          // Multi-select mode for path conditions - NodeSelector works with UUIDs
          const getPathUuids = (): string[] => {
            const c = condition as unknown as Record<string, unknown>;
            if (condition.condition_type === 'reference_path') return (c.target_uuids as string[]) || [];
            if (condition.condition_type === 'parent_path') return (c.ancestor_uuids as string[]) || [];
            if (condition.condition_type === 'child_path') return (c.descendant_uuids as string[]) || [];
            if (condition.condition_type === 'tag') return (c.tag_uuids as string[]) || [];
            return [];
          };
          const selectedUuids = getPathUuids();

          return (
            <NodeSelector
              trigger="select"
              searchMode="pages"
              value={selectedUuids.length > 0 ? selectedUuids : null}
              multi
              onAdd={(node) => handleNodeSelect(node.uuid, node)}
              onRemove={(node) => {
                const c = condition as unknown as Record<string, unknown>;
                if (condition.condition_type === 'reference_path') {
                  const uuids = (c.target_uuids as string[]) || [];
                  const idx = uuids.indexOf(node.uuid);
                  if (idx >= 0) {
                    const newUuids = [...uuids];
                    newUuids.splice(idx, 1);
                    onUpdate({ ...condition, target_uuids: newUuids, nested_group: undefined } as unknown as ConditionNode);
                  }
                } else if (condition.condition_type === 'parent_path') {
                  const uuids = (c.ancestor_uuids as string[]) || [];
                  const idx = uuids.indexOf(node.uuid);
                  if (idx >= 0) {
                    const newUuids = [...uuids];
                    newUuids.splice(idx, 1);
                    onUpdate({ ...condition, ancestor_uuids: newUuids, nested_group: undefined } as unknown as ConditionNode);
                  }
                } else if (condition.condition_type === 'child_path') {
                  const uuids = (c.descendant_uuids as string[]) || [];
                  const idx = uuids.indexOf(node.uuid);
                  if (idx >= 0) {
                    const newUuids = [...uuids];
                    newUuids.splice(idx, 1);
                    onUpdate({ ...condition, descendant_uuids: newUuids, nested_group: undefined } as unknown as ConditionNode);
                  }
                } else if (condition.condition_type === 'tag') {
                  const uuids = (c.tag_uuids as string[]) || [];
                  const idx = uuids.indexOf(node.uuid);
                  if (idx >= 0) {
                    const newUuids = [...uuids];
                    newUuids.splice(idx, 1);
                    onUpdate({ ...condition, tag_uuids: newUuids, nested_group: undefined } as unknown as ConditionNode);
                  }
                }
              }}
              placeholder={config.staticMode.placeholder}
              readOnly={readOnly}
            />
          );
        }

        // Single-select for non-path conditions (reference, parent, page, etc.)
        const selectedUuid = (condition as unknown as Record<string, unknown>).target_uuid as string | null
          || (condition as unknown as Record<string, unknown>).parent_uuid as string | null
          || (condition as unknown as Record<string, unknown>).page_uuid as string | null
          || null;
        return (
          <NodeSelector
            trigger="select"
            searchMode="pages"
            value={selectedUuid}
            onAdd={(node) => handleNodeSelect(node.uuid, node)}
            placeholder={config.staticMode.placeholder}
            readOnly={readOnly}
          />
        );
      }
      
      case 'class-selector': {
        const classNodes = selectedClassNode ? [selectedClassNode] : [];
        return (
          <NodeSelector
            nodes={classNodes}
            searchMode="classes"
            emptyText={config.staticMode.placeholder}
            searchPlaceholder="Search classes..."
            onAdd={(node) => handleNodeSelect(node.uuid, node)}
            onRemove={() => handleNodeSelect(null)}
            readOnly={readOnly}
          />
        );
      }
      
      case 'property-selector':
        // Special handling for property condition
        if (condition.condition_type === 'property') {
          const propertyName = condition.property_name || '';
          const builtInProps = [
            { value: 'uuid', label: 'uuid' },
            { value: 'id', label: 'id' },
            { value: 'create_date', label: 'create date' },
            { value: 'write_date', label: 'write date' },
            { value: 'open_date', label: 'open date' },
          ];
          const customProps = allProperties.map(p => ({ value: p.name, label: p.name }));
          const allProps = [...builtInProps, ...customProps];

          return (
            <Dropdown
              value={propertyName}
              onChange={(value) => {
                const matched = allProperties.find(p => p.name === value);
                onUpdate({
                  ...condition,
                  property_name: value || '',
                  property_uuid: matched?.uuid ?? undefined,
                  property_type: matched?.type ?? 'text',
                } as unknown as ConditionNode);
              }}
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
  
  // Style type options for style conditions
  const STYLE_TYPE_OPTIONS = [
    { value: 'bold', label: 'BOLD' },
    { value: 'italic', label: 'ITALIC' },
    { value: 'underline', label: 'UNDERLINE' },
    { value: 'strikethrough', label: 'STRIKETHROUGH' },
    { value: 'broken_link', label: 'BROKEN LINK' },
  ];

  // Get display label - dynamic for style conditions
  const displayLabel = condition.condition_type === 'style'
    ? (STYLE_TYPE_OPTIONS.find(o => o.value === (condition as unknown as Record<string, unknown>).style_type)?.label || 'STYLE')
    : config.label;

  // Handler for style type change
  const handleStyleTypeChange = (newStyleType: string | null) => {
    if (!newStyleType) return;
    onUpdate({
      ...condition,
      style_type: newStyleType as StyleType,
    } as unknown as ConditionNode);
  };

  // Render property name dropdown for property conditions
  const renderPropertyName = () => {
    if (condition.condition_type !== 'property') return null;

    const propertyName = condition.property_name || '';
    const builtInProps = [
      { value: 'uuid', label: 'uuid' },
      { value: 'id', label: 'id' },
      { value: 'create_date', label: 'create date' },
      { value: 'write_date', label: 'write date' },
      { value: 'open_date', label: 'open date' },
    ];
    const customProps = allProperties.map(p => ({ value: p.name, label: p.name }));
    const allProps = [...builtInProps, ...customProps];

    return (
      <Dropdown
        value={propertyName}
        onChange={(value) => {
          const matched = allProperties.find(p => p.name === value);
          onUpdate({
            ...condition,
            property_name: value || '',
            property_uuid: matched?.uuid ?? undefined,
            property_type: matched?.type ?? 'text',
          } as unknown as ConditionNode);
        }}
        options={allProps}
        placeholder="Select property"
        disabled={readOnly}
        size="sm"
        className="prose-condition__input"
      />
    );
  };

  // Main render
  return (
    <div className="prose-condition__inline">
      {condition.condition_type === 'style' ? (
        <Dropdown
          value={(condition as unknown as Record<string, unknown>).style_type as string}
          onChange={handleStyleTypeChange}
          disabled={readOnly}
          options={STYLE_TYPE_OPTIONS}
          size="sm"
          className="prose-condition__label-dropdown"
        />
      ) : (
        <span className="prose-condition__word">{displayLabel}</span>
      )}
      {renderPropertyName()}
      {renderOperator()}
      {renderDateChips()}
      {renderStaticInput()}
      {renderModeToggle()}
    </div>
  );
}

