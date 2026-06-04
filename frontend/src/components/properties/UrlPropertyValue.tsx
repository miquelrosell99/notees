import { useState, useCallback } from 'react';
import { Button } from '@/components/core/Button';
import './UrlPropertyValue.css';

interface UrlPropertyValueProps {
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
  validationRules?: Record<string, unknown> | null;
}

/** Render a URL value as a clickable link */
export function UrlPropertyValue({ value, readOnly, onChange, validationRules }: UrlPropertyValueProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const strValue = typeof value === 'string' ? value : '';

  const handleSave = useCallback(() => {
    const trimmed = editValue.trim();
    if (validationRules?.pattern && trimmed) {
      try {
        if (!new RegExp(String(validationRules.pattern)).test(trimmed)) {
          setValidationError(`Does not match pattern: ${validationRules.pattern}`);
          return;
        }
      } catch { /* invalid regex */ }
    }
    setValidationError(null);
    setIsEditing(false);
    onChange(trimmed);
  }, [editValue, validationRules, onChange]);

  if (isEditing) {
    return (
      <div>
        <input
          type="url"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') setIsEditing(false);
          }}
          autoFocus
          className={`property-value-input ${validationError ? 'property-value-input--error' : ''}`}
          placeholder="https://..."
        />
        {validationError && <div className="property-validation-error">{validationError}</div>}
      </div>
    );
  }

  if (strValue) {
    return (
      <span className="property-value-url">
        <a href={strValue} target="_blank" rel="noopener noreferrer" className="property-link" onClick={e => e.stopPropagation()}>
          {strValue}
        </a>
        {!readOnly && (
          <button type="button" className="property-link-edit hover-reveal" onClick={() => { setEditValue(strValue); setValidationError(null); setIsEditing(true); }} title="Edit URL">✎</button>
        )}
      </span>
    );
  }

  return (
    <Button variant="ghost" className="property-value-display" onClick={() => { setEditValue(''); setValidationError(null); setIsEditing(true); }} disabled={readOnly}>
      <span className="property-placeholder">Empty</span>
    </Button>
  );
}
