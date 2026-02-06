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
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty } from '@/hooks';
import { useQuery } from '@tanstack/react-query';
import { getNode } from '@/api/nodes';
import { Block } from '../blocks/Block';
import { NodePill } from '../NodePill';
import { Pill } from '../core/Pill';
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
    
    return <BlockCell nodeId={value} />;
  }

  // Node-type property: single value = Block, multi value = pills
  if (property.type === 'node') {
    if (value === null || value === undefined) {
      return (
        <div className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}>
          {editable ? '—' : ''}
        </div>
      );
    }
    
    // Check if multi-value (array)
    const isMultiValue = Array.isArray(value);
    const nodeIds: number[] = isMultiValue
      ? value.filter((v): v is number => typeof v === 'number')
      : typeof value === 'number'
        ? [value]
        : [];
    
    if (nodeIds.length === 0) {
      return (
        <div className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}>
          {editable ? '—' : ''}
        </div>
      );
    }
    
    // Multi-value: use pills
    if (isMultiValue && nodeIds.length > 0) {
      return (
        <div className="property-cell property-cell--node-multi">
          {nodeIds.map((nodeId) => (
            <NodePill
              key={nodeId}
              nodeId={nodeId}
              variant="link"
              readOnly={true}
            />
          ))}
        </div>
      );
    }
    
    // Single value: use Block component
    return <BlockCell nodeId={nodeIds[0]} />;
  }

  // Selection-type property: render pills with option labels
  if (property.type === 'selection') {
    if (value === null || value === undefined) {
      return (
        <div className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}>
          {editable ? '—' : ''}
        </div>
      );
    }
    
    const options = property.options ?? [];
    // Support both single value and multi-value (array)
    const selectedValues = Array.isArray(value) ? value : [value];
    const resolvedOptions = selectedValues
      .map(v => {
        // Value might be option id or an object with id
        const optionId = typeof v === 'object' && v !== null && 'id' in v ? (v as { id: number }).id : v;
        return options.find(opt => opt.id === optionId);
      })
      .filter((opt): opt is NonNullable<typeof opt> => opt !== undefined);
    
    if (resolvedOptions.length === 0) {
      return (
        <div className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}>
          {String(value)}
        </div>
      );
    }
    
    return (
      <div className="property-cell property-cell--selection">
        {resolvedOptions.map((option) => (
          <Pill
            key={option.id}
            label={option.icon ? `${option.icon} ${option.name}` : option.name}
            size="sm"
          />
        ))}
      </div>
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
 * BlockCell - Wrapper for rendering a node as a Block component in table cells
 * Used for text-type and single-value node-type properties
 */
function BlockCell({ nodeId }: { nodeId: number }) {
  const { data: blockNode } = useQuery({
    queryKey: ['node', nodeId],
    queryFn: () => getNode(nodeId),
  });

  if (!blockNode) {
    return (
      <div className="property-cell property-cell--loading">
        Loading...
      </div>
    );
  }

  return (
    <div className="property-cell-block">
      <Block
        block={blockNode}
        parentId={blockNode.parent_id}
        canMove={false}
        canEdit={false}
        canSelect={false}
        showChildren={false}
        showClasses={false}
        showQueryResults={false}
      />
    </div>
  );
}
