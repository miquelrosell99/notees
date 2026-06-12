import { useState, useCallback } from 'react';
import type { PropertyValueProps } from '@/features/content/components/properties/propertyValueRegistry';

/**
 * Number property value renderer (integer / float).
 * Manages its own inline editing state.
 */
export function NumberPropertyValue({
  property,
  value,
  readOnly,
  onChange,
}: PropertyValueProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const commitEdit = useCallback(() => {
    setIsEditing(false);

    let finalValue: unknown;
    if (property.type === 'integer') {
      finalValue = parseInt(editValue, 10);
      if (isNaN(finalValue as number)) return;
    } else {
      finalValue = parseFloat(editValue);
      if (isNaN(finalValue as number)) return;
    }

    const rules = property.validation_rules;
    if (rules && finalValue != null && finalValue !== '') {
      if (rules.min != null && typeof finalValue === 'number' && finalValue < Number(rules.min)) {
        setValidationError(`Minimum value is ${rules.min}`);
        return;
      }
      if (rules.max != null && typeof finalValue === 'number' && finalValue > Number(rules.max)) {
        setValidationError(`Maximum value is ${rules.max}`);
        return;
      }
    }
    setValidationError(null);
    onChange(finalValue);
  }, [editValue, property.type, property.validation_rules, onChange]);

  return (
    <div>
      <input
        type="text"
        inputMode={property.type === 'float' ? 'decimal' : 'numeric'}
        value={isEditing ? editValue : (value != null ? String(value) : '')}
        placeholder="Empty"
        disabled={readOnly}
        onFocus={() => {
          setEditValue(String(value ?? ''));
          setValidationError(null);
          setIsEditing(true);
        }}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitEdit();
          if (e.key === 'Escape') {
            setIsEditing(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`property-value-inline-input ${validationError ? 'property-value-input--error' : ''}`}
      />
      {validationError && <div className="property-validation-error">{validationError}</div>}
    </div>
  );
}
