/**
 * PropertyCell Component
 * 
 * Editable property cell for table view.
 * Click to edit or create property value for a node.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Property, Node } from '@/types/api';
import { useSetNodeProperty } from '@/hooks';
import { useQuery } from '@tanstack/react-query';
import { getNode } from '@/api/nodes';
import { getAssetUrl } from '@/api/assets';
import { ImageModal } from '../core/ImageModal';
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
  const [isModalOpen, setIsModalOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const setPropertyMutation = useSetNodeProperty();
  
  // Fetch asset node if property type is 'node' and value is a number (asset ID)
  const assetNodeId = property.type === 'node' && typeof value === 'number' ? value : null;
  const { data: assetNode } = useQuery({
    queryKey: ['node', assetNodeId],
    queryFn: () => getNode(assetNodeId!),
    enabled: assetNodeId !== null,
  });
  
  // Get asset URL if it's an asset node
  const assetUrl = useMemo(() => {
    if (assetNode?.uuid) {
      return getAssetUrl(assetNode.uuid);
    }
    return null;
  }, [assetNode]);

  // Format value for display
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
        // Handle selection type - value might be option id
        if (property.options && Array.isArray(property.options)) {
          const option = property.options.find(opt => opt.id === value);
          return option ? option.name : String(value);
        }
        return String(value);
      case 'node':
        // If we have the asset node, show its name
        if (assetNode) {
          return assetNode.name || 'Unnamed asset';
        }
        return `Node ${value}`;
      default:
        return String(value);
    }
  }, [value, property, assetNode]);

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

  // Display mode
  return (
    <>
      <div 
        className={`property-cell ${editable ? 'property-cell--editable' : ''} ${!displayValue ? 'property-cell--empty' : ''} ${assetUrl ? 'property-cell--image' : ''}`}
        onClick={assetUrl ? (e) => { e.stopPropagation(); setIsModalOpen(true); } : handleClick}
        title={assetUrl ? 'Click to view full size' : (editable ? 'Click to edit' : undefined)}
        style={assetUrl ? { cursor: 'pointer' } : undefined}
      >
        {assetUrl ? (
          <img 
            src={assetUrl} 
            alt={displayValue} 
            className="property-cell__image"
            loading="lazy"
          />
        ) : (
          displayValue || (editable ? '—' : '')
        )}
      </div>
      
      {assetUrl && (
        <ImageModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          src={assetUrl}
          alt={displayValue}
        />
      )}
    </>
  );
}
