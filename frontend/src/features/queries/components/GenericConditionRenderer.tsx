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
import { NodeSelector } from '@/features/content/components/nodes/NodeSelector';

import { useNode, useProperties } from '@/hooks';
import { useNodeByUuid } from '@/hooks/useNodeQueries';
import { useCurrentNodeUuid } from '@/hooks/useRouter';
import type { ConditionNode, StyleType } from '@/types/queryAST';
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
  const currentNodeUuid = useCurrentNodeUuid();
  
  // Calculate classId for useNode hook (must be before any conditional returns)
  const classId = condition.condition_type === 'class' 
    ? (condition as unknown as Record<string, unknown>).class_id as number | null
    : condition.condition_type === 'extends' 
      ? (condition as unknown as Record<string, unknown>).extends_class_id as number | null
      : null;

  // Also extract the class UUID for fallback resolution when class_id is not set
  const classUuid = !classId
    ? (condition.condition_type === 'class'
        ? (condition as unknown as Record<string, unknown>).class_uuid as string | null
        : condition.condition_type === 'extends'
          ? (condition as unknown as Record<string, unknown>).extends_class_uuid as string | null
          : null)
    : null;
  // Filter out placeholder UUIDs that shouldn't be fetched
  const classUuidForFetch = classUuid && classUuid !== '{current_node_uuid}' ? classUuid : null;
  
  // Hooks must be called unconditionally - always call them here
  const { data: allProperties = [] } = useProperties();
  const { data: selectedClassNodeById } = useNode(classId);
  const { data: selectedClassNodeByUuid } = useNodeByUuid(classUuidForFetch);
  const selectedClassNode = selectedClassNodeById ?? selectedClassNodeByUuid;
  
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
        delete updated.parent_id;
        delete updated.parent_ids;
      } else if (condition.condition_type === 'child') {
        delete updated.child_uuids;
        delete updated.child_ids;
      } else if (condition.condition_type === 'page') {
        delete updated.page_uuid;
        delete updated.page_uuids;
        delete updated.page_id;
        delete updated.page_ids;
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
        delete updated.parent_id;
      } else if (condition.condition_type === 'reference') {
        delete updated.target_uuid;
        delete updated.target_id;
      } else if (condition.condition_type === 'reference_path') {
        updated.target_uuids = [];
        updated.target_ids = [];
      } else if (condition.condition_type === 'parent_path') {
        updated.ancestor_uuids = [];
        updated.ancestor_ids = [];
      } else if (condition.condition_type === 'child_path') {
        updated.descendant_uuids = [];
        updated.descendant_ids = [];
      } else if (condition.condition_type === 'property') {
        updated.value = '';
      } else if (condition.condition_type === 'page') {
        delete updated.page_uuid;
        delete updated.page_id;
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
        delete updated.parent_id;
      } else if (condition.condition_type === 'reference') {
        updated.target_uuid = targetUuid;
        delete updated.target_id;
      } else if (condition.condition_type === 'reference_path') {
        updated.target_uuids = [targetUuid];
        delete updated.target_ids;
      } else if (condition.condition_type === 'parent_path') {
        updated.ancestor_uuids = [targetUuid];
        delete updated.ancestor_ids;
      } else if (condition.condition_type === 'child_path') {
        updated.descendant_uuids = [targetUuid];
        delete updated.descendant_ids;
      } else if (condition.condition_type === 'property') {
        updated.value = targetUuid;
      } else if (condition.condition_type === 'class') {
        updated.class_uuid = targetUuid;
        delete updated.class_id;
      } else if (condition.condition_type === 'extends') {
        updated.extends_class_uuid = targetUuid;
        delete updated.extends_class_id;
      } else if (condition.condition_type === 'page') {
        updated.page_uuid = targetUuid;
        delete updated.page_id;
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
  const handleNodeSelect = (nodeId: number | null, node?: { id: number; uuid: string }) => {
    const updates: Record<string, unknown> = {};
    
    if (condition.condition_type === 'class') {
      updates.class_id = nodeId ?? undefined;
      updates.class_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'reference') {
      updates.target_id = nodeId ?? undefined;
      updates.target_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'reference_path') {
      // Multi-select: append to target_uuids/target_ids arrays
      const existing = condition as unknown as Record<string, unknown>;
      if (nodeId && node?.uuid) {
        const currentUuids = (existing.target_uuids as string[]) || [];
        const currentIds = (existing.target_ids as number[]) || [];
        if (!currentUuids.includes(node.uuid)) {
          updates.target_uuids = [...currentUuids, node.uuid];
          updates.target_ids = [...currentIds, nodeId];
        }
      } else {
        // Remove: nodeId is null means clearing
        updates.target_uuids = [];
        updates.target_ids = [];
      }
    } else if (condition.condition_type === 'parent_path') {
      // Multi-select: append to ancestor_uuids/ancestor_ids arrays
      const existing = condition as unknown as Record<string, unknown>;
      if (nodeId && node?.uuid) {
        const currentUuids = (existing.ancestor_uuids as string[]) || [];
        const currentIds = (existing.ancestor_ids as number[]) || [];
        if (!currentUuids.includes(node.uuid)) {
          updates.ancestor_uuids = [...currentUuids, node.uuid];
          updates.ancestor_ids = [...currentIds, nodeId];
        }
      } else {
        updates.ancestor_uuids = [];
        updates.ancestor_ids = [];
      }
    } else if (condition.condition_type === 'child_path') {
      // Multi-select: append to descendant_uuids/descendant_ids arrays
      const existing = condition as unknown as Record<string, unknown>;
      if (nodeId && node?.uuid) {
        const currentUuids = (existing.descendant_uuids as string[]) || [];
        const currentIds = (existing.descendant_ids as number[]) || [];
        if (!currentUuids.includes(node.uuid)) {
          updates.descendant_uuids = [...currentUuids, node.uuid];
          updates.descendant_ids = [...currentIds, nodeId];
        }
      } else {
        updates.descendant_uuids = [];
        updates.descendant_ids = [];
      }
    } else if (condition.condition_type === 'parent') {
      updates.parent_id = nodeId ?? undefined;
      updates.parent_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'extends') {
      updates.extends_class_id = nodeId ?? undefined;
      updates.extends_class_uuid = node?.uuid ?? '';
    } else if (condition.condition_type === 'page') {
      updates.page_id = nodeId ?? undefined;
      updates.page_uuid = node?.uuid ?? '';
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
            placeholder={config.staticMode.placeholder}
            disabled={readOnly}
            size="sm"
            className={`prose-condition__input ${showError ? 'prose-condition__input--error' : ''}`}
          />
        );
      }
      
      case 'node-selector': {
        // Path conditions use plural arrays (target_uuids, ancestor_uuids, descendant_uuids)
        const isPathCondition = ['reference_path', 'parent_path', 'child_path'].includes(condition.condition_type);
        
        if (isPathCondition) {
          // Multi-select mode for path conditions
          const getPathIds = (): number[] => {
            const c = condition as unknown as Record<string, unknown>;
            if (condition.condition_type === 'reference_path') return (c.target_ids as number[]) || [];
            if (condition.condition_type === 'parent_path') return (c.ancestor_ids as number[]) || [];
            if (condition.condition_type === 'child_path') return (c.descendant_ids as number[]) || [];
            return [];
          };
          const selectedIds = getPathIds();
          
          return (
            <NodeSelector
              trigger="select"
              searchMode="pages"
              value={selectedIds.length > 0 ? selectedIds : null}
              multi
              onAdd={(node) => handleNodeSelect(node.id, node)}
              onRemove={(node) => {
                const c = condition as unknown as Record<string, unknown>;
                if (condition.condition_type === 'reference_path') {
                  const idx = ((c.target_ids as number[]) || []).indexOf(node.id);
                  if (idx >= 0) {
                    const newIds = [...((c.target_ids as number[]) || [])];
                    const newUuids = [...((c.target_uuids as string[]) || [])];
                    newIds.splice(idx, 1);
                    newUuids.splice(idx, 1);
                    onUpdate({ ...condition, target_ids: newIds, target_uuids: newUuids, nested_group: undefined } as unknown as ConditionNode);
                  }
                } else if (condition.condition_type === 'parent_path') {
                  const idx = ((c.ancestor_ids as number[]) || []).indexOf(node.id);
                  if (idx >= 0) {
                    const newIds = [...((c.ancestor_ids as number[]) || [])];
                    const newUuids = [...((c.ancestor_uuids as string[]) || [])];
                    newIds.splice(idx, 1);
                    newUuids.splice(idx, 1);
                    onUpdate({ ...condition, ancestor_ids: newIds, ancestor_uuids: newUuids, nested_group: undefined } as unknown as ConditionNode);
                  }
                } else if (condition.condition_type === 'child_path') {
                  const idx = ((c.descendant_ids as number[]) || []).indexOf(node.id);
                  if (idx >= 0) {
                    const newIds = [...((c.descendant_ids as number[]) || [])];
                    const newUuids = [...((c.descendant_uuids as string[]) || [])];
                    newIds.splice(idx, 1);
                    newUuids.splice(idx, 1);
                    onUpdate({ ...condition, descendant_ids: newIds, descendant_uuids: newUuids, nested_group: undefined } as unknown as ConditionNode);
                  }
                }
              }}
              placeholder={config.staticMode.placeholder}
              readOnly={readOnly}
            />
          );
        }
        
        // Single-select for non-path conditions (reference, parent, page, etc.)
        const selectedId = (condition as unknown as Record<string, unknown>).target_id as number | null
          || (condition as unknown as Record<string, unknown>).parent_id as number | null
          || (condition as unknown as Record<string, unknown>).page_id as number | null
          || null;
        return (
          <NodeSelector
            trigger="select"
            searchMode="pages"
            value={selectedId}
            onAdd={(node) => handleNodeSelect(node.id, node)}
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
            onAdd={(node) => handleNodeSelect(node.id, node)}
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
      {renderStaticInput()}
      {renderModeToggle()}
    </div>
  );
}

