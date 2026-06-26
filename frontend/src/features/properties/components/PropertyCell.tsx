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
import { useSetNodeProperty } from '../hooks';
import { useClasses } from '@/features/content';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { InlineBlock } from './InlineBlock';
import { NodePropertyCell } from './NodePropertyCell';
import { SelectionPropertyCell } from './SelectionPropertyCell';
import { UrlPropertyCell } from './UrlPropertyCell';
import { EmailPropertyCell } from './EmailPropertyCell';
import { DatePropertyCell } from './DatePropertyCell';
import { AssetImage } from '@/features/content';
import { getPropertyValueRenderer } from '../utils/propertyValueRegistry';
import '../utils/registerPropertyRenderers';
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

  // Detect asset-type node properties by checking if class_filter_uuids includes the asset class
  const { data: allClasses } = useClasses();
  const isAssetProperty = useMemo(() => {
    if (property.type !== 'node' || !property.class_filter_uuids?.length || !allClasses) return false;
    return property.class_filter_uuids.some(classUuid => {
      const classNode = allClasses.find(c => c.uuid === classUuid);
      return classNode?.uuid === SYSTEM_CLASS_UUIDS.asset;
    });
  }, [property.type, property.class_filter_uuids, allClasses]);

  // Format value for display (used for non-node, non-selection types)
  const displayValue = useMemo(() => {
    if (value === null || value === undefined) return '';
    const renderer = getPropertyValueRenderer(property.type);
    if (renderer) {
      return renderer.formatValue(value);
    }
    return String(value);
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
    const renderer = getPropertyValueRenderer(property.type);
    if (renderer && property.type === 'integer') {
      finalValue = parseInt(editValue, 10);
      if (isNaN(finalValue as number)) return;
    } else if (renderer && property.type === 'float') {
      finalValue = parseFloat(editValue);
      if (isNaN(finalValue as number)) return;
    } else if (renderer && property.type === 'boolean') {
      finalValue = editValue === 'true' || editValue === '✓' || editValue === '1';
    } else {
      finalValue = editValue;
    }

    // Validate against validation_rules
    const rules = property.validation_rules;
    if (rules && finalValue != null && finalValue !== '') {
      if (rules.pattern && typeof finalValue === 'string') {
        try {
          if (!new RegExp(String(rules.pattern)).test(finalValue)) return;
        } catch { /* invalid regex */ }
      }
      if (rules.min != null && typeof finalValue === 'number' && finalValue < Number(rules.min)) return;
      if (rules.max != null && typeof finalValue === 'number' && finalValue > Number(rules.max)) return;
    }

    try {
      await setPropertyMutation.mutateAsync({
        nodeUuid: node.uuid,
        propertyId: property.uuid,
        value: finalValue,
      });
    } catch (error) {
      console.error('Failed to save property:', error);
    }
  }, [isEditing, editValue, displayValue, property, node.uuid, setPropertyMutation]);

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

  // Text-type property: value is a block node ID or array of block node IDs (multi)
  if (property.type === 'text' && !isEditing) {
    if (property.multi && Array.isArray(value)) {
      if (value.length === 0) {
        return (
          <div className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}>
            <span className="property-placeholder">Empty</span>
          </div>
        );
      }
      return (
        <div className="property-cell property-cell--multi-text">
          {(value as string[]).map((id) => (
            <InlineBlock key={id} nodeUuid={id} />
          ))}
        </div>
      );
    }
    if (value === null || value === undefined || typeof value !== 'string') {
      return (
        <div className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}>
          <span className="property-placeholder">Empty</span>
        </div>
      );
    }

    return <InlineBlock nodeUuid={value} />;
  }

  // Image-type property: always render with AssetImage
  if (property.type === 'image') {
    const imageId = typeof value === 'string' ? value : null;
    if (!imageId) {
      return (
        <div className={`property-cell ${editable ? 'property-cell--editable' : ''} property-cell--empty`}>
          <span className="property-placeholder">Empty</span>
        </div>
      );
    }
    return (
      <div className="property-cell property-cell--image">
        <AssetImage
          assetNodeId={imageId}
          showCard={false}
          clickable={true}
          showActions={false}
          className="property-cell__asset"
          imageClassName="property-cell__asset-img"
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

  // URL-type property
  if (property.type === 'url') {
    return (
      <UrlPropertyCell
        node={node}
        property={property}
        value={value}
        editable={editable}
      />
    );
  }

  // Email-type property
  if (property.type === 'email') {
    return (
      <EmailPropertyCell
        node={node}
        property={property}
        value={value}
        editable={editable}
      />
    );
  }

  // Date-type property
  if (property.type === 'date') {
    return (
      <DatePropertyCell
        node={node}
        property={property}
        value={value}
        editable={editable}
      />
    );
  }

  // Handle boolean toggle
  if (property.type === 'boolean' && !isEditing) {
    return (
      <button
        type="button"
        aria-pressed={Boolean(value)}
        className="property-cell property-cell--boolean"
        onClick={handleClick}
      >
        <input
          type="checkbox"
          checked={Boolean(value)}
          readOnly
          tabIndex={-1}
          aria-hidden="true"
          className="property-cell__checkbox"
        />
      </button>
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
          ref={inputRef as unknown as React.RefCallback<HTMLInputElement & HTMLTextAreaElement>}
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
    <button
      type="button"
      className={`property-cell ${editable ? 'property-cell--editable' : ''} ${!displayValue ? 'property-cell--empty' : ''}`}
      onClick={handleClick}
      title={editable ? 'Click to edit' : undefined}
    >
      {displayValue || <span className="property-placeholder">Empty</span>}
    </button>
  );
}
