/**
 * PropertyCell Component
 * 
 * Editable property cell for table view.
 * Click to edit or create property value for a node.
 * 
 * Node-type properties:
 * - Single value: Render as Block component (readonly)
 * - Multi value: Render as NodePill(s) showing the referenced node name/icon
 * 
 * Text-type properties: Render as Block component (the value is a block node ID)
 * Selection-type properties render as pills with selection option labels.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty, useClasses, useNode, nodeKeys } from '@/hooks';
import { useClickOutside } from '@/hooks/useClickOutside';
import * as nodesApi from '@/api/nodes';
import { NodeInline } from '../blocks/NodeInline';
import { ImageNode } from '../nodes/ImageNode';
import { NodePill } from '../NodePill';
import { NodeSelector } from '../NodeSelector';
import { Pill } from '../core/Pill';
import { Button } from '../core/Button';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { useAppStore } from '@/stores';
import './PropertyCell.css';

interface PropertyCellProps {
  node: Node;
  property: Property;
  value: unknown;
  editable?: boolean;
}

/**
 * PropertyCell - Display and edit property values in table
 */
export function PropertyCell({
  node,
  property,
  value,
  editable = false,
}: PropertyCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const setPropertyMutation = useSetNodeProperty();

  // Detect asset-type node properties by checking if class_filters includes the asset class
  const { data: allClasses } = useClasses();
  const isAssetProperty = useMemo(() => {
    if (property.type !== 'node' || !property.class_filters?.length || !allClasses) return false;
    return property.class_filters.some(classId => {
      const classNode = allClasses.find(c => c.id === classId);
      return classNode?.uuid === SYSTEM_CLASS_UUIDS.asset;
    });
  }, [property.type, property.class_filters, allClasses]);

  // Format value for display (used for non-node, non-selection types)
  const displayValue = useMemo(() => {
    if (value === null || value === undefined) return '';
    
    switch (property.type) {
      case 'boolean':
        return value ? '✓' : '';
      case 'integer':
      case 'float':
        return String(value);
      case 'text':
        // Text properties are block node IDs - handled separately with Block component
        return '';
      case 'selection':
        // Handled separately with pills
        return '';
      case 'node':
        // Handled separately with Block or pills
        return '';
      case 'image':
        // Handled separately with ImageNode
        return '';
      default:
        return String(value);
    }
  }, [value, property.type]);

  // Start editing
  const handleClick = useCallback(() => {
    if (!editable) return;
    
    setEditValue(displayValue);
    setIsEditing(true);
  }, [editable, displayValue]);

  // Save changes
  const handleSave = useCallback(async () => {
    if (!isEditing) return;
    
    setIsEditing(false);
    
    // Don't save if value hasn't changed
    if (editValue === displayValue) return;
    
    // Convert value based on property type
    let finalValue: unknown;
    switch (property.type) {
      case 'integer':
        finalValue = parseInt(editValue, 10);
        if (isNaN(finalValue as number)) return;
        break;
      case 'float':
        finalValue = parseFloat(editValue);
        if (isNaN(finalValue as number)) return;
        break;
      case 'boolean':
        finalValue = editValue === 'true' || editValue === '✓' || editValue === '1';
        break;
      default:
        finalValue = editValue;
    }
    
    try {
      await setPropertyMutation.mutateAsync({
        nodeId: node.id,
        propertyId: property.id,
        value: finalValue,
      });
    } catch (error) {
      console.error('Failed to save property:', error);
    }
  }, [isEditing, editValue, displayValue, property, node.id, setPropertyMutation]);

  // Cancel editing
  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditValue('');
  }, []);

  // Handle keyboard events
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  }, [handleSave, handleCancel]);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Text-type property: value is a block node ID, render as Block
  if (property.type === 'text') {
    if (value === null || value === undefined || typeof value !== 'number') {
      return (
        <div className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}>
          {editable ? '—' : ''}
        </div>
      );
    }
    
    return <InlineBlock nodeId={value} />;
  }

  // Image-type property: always render with ImageNode
  if (property.type === 'image') {
    const imageId = typeof value === 'number' ? value : null;
    if (!imageId) {
      return (
        <div className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}>
          {editable ? '—' : ''}
        </div>
      );
    }
    return (
      <div className="property-cell property-cell--image">
        <ImageNode
          assetNodeId={imageId}
          showCard={false}
          clickable={true}
          showActions={false}
        />
      </div>
    );
  }

  // Node-type property: use NodePropertyCell for all cases (empty/single/multi, asset/regular)
  if (property.type === 'node') {
    return (
      <NodePropertyCell
        property={property}
        parentNode={node}
        value={value}
        editable={editable}
        isAssetProperty={isAssetProperty}
      />
    );
  }

  // Selection-type property: use SelectionPropertyCell
  if (property.type === 'selection') {
    return (
      <SelectionPropertyCell
        property={property}
        parentNode={node}
        value={value}
        editable={editable}
      />
    );
  }

  // Handle boolean toggle
  if (property.type === 'boolean' && !isEditing) {
    return (
      <div 
        className="property-cell property-cell--boolean"
        onClick={handleClick}
      >
        <input
          type="checkbox"
          checked={Boolean(value)}
          readOnly={!editable}
          className="property-cell__checkbox"
        />
      </div>
    );
  }

  // Editing mode
  if (isEditing) {
    const InputComponent = property.type === 'text' && editValue.length > 50 
      ? 'textarea' 
      : 'input';
    
    return (
      <div className="property-cell property-cell--editing">
        <InputComponent
          ref={inputRef as any}
          className="property-cell__input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          type={property.type === 'integer' || property.type === 'float' ? 'number' : 'text'}
          step={property.type === 'float' ? 'any' : undefined}
        />
      </div>
    );
  }

  // Display mode for scalar types (text, integer, float, date)
  return (
    <div 
      className={`property-cell ${editable ? 'property-cell--editable' : ''} ${!displayValue ? 'property-cell--empty' : ''}`}
      onClick={handleClick}
      title={editable ? 'Click to edit' : undefined}
    >
      {displayValue || (editable ? '—' : '')}
    </div>
  );
}

/**
 * InlineBlock - Fetches a node by ID and renders it as a read-only Block.
 * Used for text properties (value is a block node ID) and single-value node properties.
 */
function InlineBlock({ nodeId }: { nodeId: number }) {
  const { data: blockNode } = useNode(nodeId);

  if (!blockNode) {
    return (
      <div className="property-cell property-cell--loading">
        Loading...
      </div>
    );
  }

  return (
    <NodeInline
      name={blockNode.name}
      icon={blockNode.icon}
      isPage={blockNode.is_page}
      nodeId={blockNode.id}
    />
  );
}

/**
 * MultiNodePropertyCell - Renders multi-value node properties using NodeSelector
 * Fetches all node data and provides add/remove functionality
 */
function MultiNodePropertyCell({
  nodeIds,
  property,
  parentNode,
  value,
  editable,
}: {
  nodeIds: number[];
  property: Property;
  parentNode: Node;
  value: unknown;
  editable: boolean;
}) {
  const setPropertyMutation = useSetNodeProperty();
  const { openNode } = useAppStore();

  // Fetch all nodes in parallel
  const nodeQueries = useQueries({
    queries: nodeIds.map((nodeId) => ({
      queryKey: nodeKeys.detail(nodeId, { include_children: false }),
      queryFn: () => nodesApi.getNode(nodeId, { include_children: false }),
      staleTime: 5 * 60 * 1000,
    })),
  });

  // Extract resolved nodes
  const resolvedNodes = useMemo(() => {
    return nodeQueries
      .map(query => query.data)
      .filter((n): n is Node => n !== undefined);
  }, [nodeQueries]);

  // Show loading state if any query is loading
  const isLoading = nodeQueries.some(q => q.isLoading);

  if (isLoading) {
    return (
      <div className="property-cell property-cell--loading">
        Loading...
      </div>
    );
  }

  return (
    <div className="property-cell property-cell--node-multi">
      <NodeSelector
        nodes={resolvedNodes}
        searchMode="pages"
        classFilters={property.class_filters}
        emptyText="Add"
        searchPlaceholder="Search..."
        onNodeClick={(selectedNode) => {
          openNode(selectedNode.id, 'page');
        }}
        onAdd={editable ? (selectedNode) => {
          const currentValue = Array.isArray(value) ? value : [];
          setPropertyMutation.mutate({
            nodeId: parentNode.id,
            propertyId: property.id,
            value: [...currentValue, selectedNode.id],
          });
        } : undefined}
        onRemove={editable ? (selectedNode) => {
          const currentValue = Array.isArray(value) ? value : [];
          setPropertyMutation.mutate({
            nodeId: parentNode.id,
            propertyId: property.id,
            value: currentValue.filter(id => id !== selectedNode.id),
          });
        } : undefined}
        readOnly={!editable}
      />
    </div>
  );
}

/**
 * NodePropertyCell - Handles all node-type properties (empty/single/multi, asset/regular)
 * Uses NodeSelector for regular nodes, ImageNode for assets
 */
function NodePropertyCell({
  property,
  parentNode,
  value,
  editable,
  isAssetProperty,
}: {
  property: Property;
  parentNode: Node;
  value: unknown;
  editable: boolean;
  isAssetProperty: boolean;
}) {
  const setPropertyMutation = useSetNodeProperty();
  const { openNode } = useAppStore();

  // Parse node IDs from value
  const isMultiValue = property.is_multi || Array.isArray(value);
  const nodeIds: number[] = isMultiValue && Array.isArray(value)
    ? value.filter((v): v is number => typeof v === 'number')
    : typeof value === 'number'
      ? [value]
      : [];

  // Fetch all nodes in parallel
  const nodeQueries = useQueries({
    queries: nodeIds.map((nodeId) => ({
      queryKey: nodeKeys.detail(nodeId, { include_children: false }),
      queryFn: () => nodesApi.getNode(nodeId, { include_children: false }),
      staleTime: 5 * 60 * 1000,
    })),
  });

  // Extract resolved nodes
  const resolvedNodes = useMemo(() => {
    return nodeQueries
      .map(query => query.data)
      .filter((n): n is Node => n !== undefined);
  }, [nodeQueries]);

  const isLoading = nodeQueries.some(q => q.isLoading);

  // Asset properties: render as images
  if (isAssetProperty && nodeIds.length > 0) {
    if (isLoading) {
      return (
        <div className="property-cell property-cell--loading">
          Loading...
        </div>
      );
    }

    return (
      <div className="property-cell property-cell--image">
        {nodeIds.map((nodeId) => (
          <ImageNode
            key={nodeId}
            assetNodeId={nodeId}
            showCard={false}
            clickable={true}
            showActions={false}
          />
        ))}
      </div>
    );
  }

  // Regular node properties: use NodeSelector
  if (isLoading && nodeIds.length > 0) {
    return (
      <div className="property-cell property-cell--loading">
        Loading...
      </div>
    );
  }

  return (
    <div className="property-cell property-cell--node-multi">
      <NodeSelector
        nodes={resolvedNodes}
        searchMode="pages"
        classFilters={property.class_filters}
        emptyText="Add"
        searchPlaceholder="Search..."
        onNodeClick={(selectedNode) => {
          openNode(selectedNode.id, 'page');
        }}
        onAdd={editable ? (selectedNode) => {
          const currentValue = isMultiValue && Array.isArray(value) ? value : (value ? [value] : []);
          const newValue = property.is_multi 
            ? [...currentValue, selectedNode.id]
            : selectedNode.id;
          setPropertyMutation.mutate({
            nodeId: parentNode.id,
            propertyId: property.id,
            value: newValue,
          });
        } : undefined}
        onRemove={editable ? (selectedNode) => {
          if (property.is_multi && Array.isArray(value)) {
            setPropertyMutation.mutate({
              nodeId: parentNode.id,
              propertyId: property.id,
              value: value.filter(id => id !== selectedNode.id),
            });
          } else {
            // Single value: remove means set to null
            setPropertyMutation.mutate({
              nodeId: parentNode.id,
              propertyId: property.id,
              value: null,
            });
          }
        } : undefined}
        readOnly={!editable}
      />
    </div>
  );
}

/**
 * SelectionPropertyCell - Handles selection-type properties with picker
 */
function SelectionPropertyCell({
  property,
  parentNode,
  value,
  editable,
}: {
  property: Property;
  parentNode: Node;
  value: unknown;
  editable: boolean;
}) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);
  const setPropertyMutation = useSetNodeProperty();
  const options = property.options ?? [];

  // Close picker on outside click
  useClickOutside(cellRef, () => {
    if (isPickerOpen) setIsPickerOpen(false);
  }, isPickerOpen);

  // Parse selected values
  const selectedValues = Array.isArray(value) ? value : value ? [value] : [];
  const resolvedOptions = selectedValues
    .map(v => {
      const optionId = typeof v === 'object' && v !== null && 'id' in v ? (v as { id: number }).id : v;
      return options.find(opt => opt.id === optionId);
    })
    .filter((opt): opt is NonNullable<typeof opt> => opt !== undefined);

  const handleAddOption = (option: typeof options[0]) => {
    if (property.is_multi) {
      const currentValue = Array.isArray(value) ? value : [];
      setPropertyMutation.mutate({
        nodeId: parentNode.id,
        propertyId: property.id,
        value: [...currentValue, option.id],
      });
    } else {
      setPropertyMutation.mutate({
        nodeId: parentNode.id,
        propertyId: property.id,
        value: option.id,
      });
    }
    setIsPickerOpen(false);
  };

  const handleRemoveOption = (option: typeof options[0]) => {
    if (property.is_multi && Array.isArray(value)) {
      setPropertyMutation.mutate({
        nodeId: parentNode.id,
        propertyId: property.id,
        value: value.filter(id => id !== option.id),
      });
    } else {
      setPropertyMutation.mutate({
        nodeId: parentNode.id,
        propertyId: property.id,
        value: null,
      });
    }
  };

  // Empty state
  if (resolvedOptions.length === 0) {
    return (
      <div 
        ref={cellRef}
        className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}
        onClick={() => editable && setIsPickerOpen(true)}
        title={editable ? 'Click to select' : undefined}
      >
        {editable ? '—' : ''}
        {isPickerOpen && (
          <div className="property-cell__picker">
            {options.map(option => (
              <div
                key={option.id}
                className="property-cell__picker-option"
                onClick={() => handleAddOption(option)}
              >
                {option.icon && <span>{option.icon}</span>}
                <span>{option.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Has values
  return (
    <div ref={cellRef} className="property-cell property-cell--selection">
      {resolvedOptions.map((option) => (
        <Pill
          key={option.id}
          label={option.icon ? `${option.icon} ${option.name}` : option.name}
          size="sm"
          onRemove={editable ? () => handleRemoveOption(option) : undefined}
        />
      ))}
      {editable && property.is_multi && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsPickerOpen(true)}
          className="property-cell__add-button"
        >
          +
        </Button>
      )}
      {isPickerOpen && (
        <div className="property-cell__picker">
          {options
            .filter(opt => !resolvedOptions.some(r => r.id === opt.id))
            .map(option => (
              <div
                key={option.id}
                className="property-cell__picker-option"
                onClick={() => handleAddOption(option)}
              >
                {option.icon && <span>{option.icon}</span>}
                <span>{option.name}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

