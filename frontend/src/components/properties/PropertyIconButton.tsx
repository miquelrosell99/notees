/**
 * PropertyIconButton Component
 * 
 * Renders a clickable icon button for a selection property value at the block level.
 * Clicking it opens the same picker dropdown used for setting the property value.
 * 
 * Positioning is controlled by the parent (Block component) based on the property's
 * icon_visibility setting: 'before_content' or 'after_bullet'.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import type { Property, SelectionOption, Node } from '@/types/api';
import { useSetNodeProperty } from '@/hooks';
import './PropertyIconButton.css';


interface PropertyIconButtonProps {
  /** The property definition */
  property: Property;
  /** The node this property value belongs to */
  node: Node;
  /** Current property value (selection line ID or array of IDs) */
  value: unknown;
  /** Whether the user can edit (change the value) */
  editable?: boolean;
}

export function PropertyIconButton({
  property,
  node,
  value,
  editable = true,
}: PropertyIconButtonProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const setPropertyMutation = useSetNodeProperty();
  const options = property.options ?? [];

  // Resolve current selection
  const selectedValues = Array.isArray(value) ? value : value ? [value] : [];
  const resolvedOptions = selectedValues
    .map(v => {
      const optionId = typeof v === 'object' && v !== null && 'id' in v ? (v as { id: number }).id : v;
      return options.find(opt => opt.id === optionId);
    })
    .filter((opt): opt is SelectionOption => opt !== undefined);

  // Get the icon to display (first selected option's icon, or property icon)
  const displayIcon = resolvedOptions.length > 0 && resolvedOptions[0].icon
    ? resolvedOptions[0].icon
    : null;

  // Close dropdown on outside click
  useEffect(() => {
    if (!isPickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        pickerRef.current && !pickerRef.current.contains(e.target as HTMLElement) &&
        buttonRef.current && !buttonRef.current.contains(e.target as HTMLElement)
      ) {
        setIsPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isPickerOpen]);

  const handleSelectOption = useCallback((option: SelectionOption) => {
    if (property.multi) {
      const currentValue = Array.isArray(value) ? value : [];
      setPropertyMutation.mutate({
        nodeId: node.id,
        propertyId: property.id,
        value: [...currentValue, option.id],
      });
    } else {
      setPropertyMutation.mutate({
        nodeId: node.id,
        propertyId: property.id,
        value: option.id,
      });
    }
    setIsPickerOpen(false);
  }, [property, node.id, value, setPropertyMutation]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (editable) {
      setIsPickerOpen(prev => !prev);
    }
  }, [editable]);

  // Don't render if no icon to show
  if (!displayIcon) return null;

  return (
    <span className="property-icon-button-wrapper">
      <button
        ref={buttonRef}
        className={`property-icon-button${editable ? ' property-icon-button--editable' : ''}`}
        onClick={handleClick}
        title={`${property.name}: ${resolvedOptions.map(o => o.name).join(', ')}`}
      >
        {displayIcon}
      </button>
      {isPickerOpen && (
        <div className="property-icon-picker" ref={pickerRef}>
          {options.map(option => (
            <button
              key={option.id}
              className={`property-icon-picker__option${resolvedOptions.some(r => r.id === option.id) ? ' property-icon-picker__option--selected' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                handleSelectOption(option);
              }}
            >
              {option.icon && <span className="property-icon-picker__icon">{option.icon}</span>}
              <span className="property-icon-picker__name">{option.name}</span>
              {resolvedOptions.some(r => r.id === option.id) && (
                <span className="property-icon-picker__check">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
