/**
 * PropertyTypeSelector - Streamlined property type picker
 * 
 * Shows a compact grid of property type options when creating a new property.
 * Appears after typing the property name but before creation.
 */
import { useCallback } from 'react';
import type { PropertyType } from '@/types/api';
import './PropertyTypeSelector.css';

export interface PropertyTypeOption {
  type: PropertyType;
  label: string;
  icon: string;
  description: string;
}

export const PROPERTY_TYPE_OPTIONS: PropertyTypeOption[] = [
  { type: 'text', label: 'Text', icon: '📝', description: 'Single or multi-line text' },
  { type: 'integer', label: 'Number', icon: '#️⃣', description: 'Whole numbers' },
  { type: 'float', label: 'Decimal', icon: '🔢', description: 'Numbers with decimals' },
  { type: 'boolean', label: 'Checkbox', icon: '☑️', description: 'True/false value' },
  { type: 'date', label: 'Date', icon: '📅', description: 'Date picker' },
  { type: 'selection', label: 'Selection', icon: '🏷️', description: 'Choose from options' },
  { type: 'node', label: 'Node', icon: '🔗', description: 'Link to another node' },
];

export interface PropertyTypeSelectorProps {
  /** Callback when a type is selected */
  onSelect: (type: PropertyType) => void;
  /** Callback to cancel and go back */
  onCancel: () => void;
  /** The property name being created */
  propertyName: string;
}

export function PropertyTypeSelector({
  onSelect,
  onCancel,
  propertyName,
}: PropertyTypeSelectorProps) {
  const handleSelect = useCallback((type: PropertyType) => {
    onSelect(type);
  }, [onSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent, type: PropertyType) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSelect(type);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }, [handleSelect, onCancel]);

  return (
    <div className="property-type-selector">
      <div className="property-type-selector__header">
        <button
          className="property-type-selector__back"
          onClick={onCancel}
          aria-label="Go back"
        >
          ← Back
        </button>
        <div className="property-type-selector__title">
          Select type for <strong>{propertyName}</strong>
        </div>
      </div>
      
      <div className="property-type-selector__grid">
        {PROPERTY_TYPE_OPTIONS.map((option) => (
          <button
            key={option.type}
            className="property-type-selector__option"
            onClick={() => handleSelect(option.type)}
            onKeyDown={(e) => handleKeyDown(e, option.type)}
          >
            <div className="property-type-selector__option-icon">
              {option.icon}
            </div>
            <div className="property-type-selector__option-label">
              {option.label}
            </div>
            <div className="property-type-selector__option-description">
              {option.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
