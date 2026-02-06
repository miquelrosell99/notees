/**
 * PropertyCell Component
 * 
 * Editable property cell for table view.
 * Click to edit or create property value for a node.
 * 
 * Node-type properties render as NodePill(s) showing the referenced node name/icon.
 * Selection-type properties render as pills with selection option labels.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty } from '@/hooks';
import { useNodesStore } from '@/stores';
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
  const { openNode } = useNodesStore();

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
        return String(value);
      case 'selection':
        // Handled separately with pills
        return '';
      case 'node':
        // Handled separately with NodePill
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

  // Node-type property: render NodePill(s) for referenced nodes
  if (property.type === 'node') {
    if (value === null || value === undefined) {
      return (
        <div className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}>
          {editable ? '—' : ''}
        </div>
      );
    }
    
    // Support both single value (number) and multi-value (array of numbers)
    const nodeIds: number[] = Array.isArray(value)
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
    
    return (
      <div className="property-cell property-cell--node">
        {nodeIds.map((nodeId) => (
          <NodePill
            key={nodeId}
            nodeId={nodeId}
            variant="link"
            readOnly={true}
            onClick={() => openNode(nodeId, 'page')}
          />
        ))}
      </div>
    );
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
