import { useState, useCallback, useMemo, useRef } from 'react';
import { useNode } from '@/hooks';
import type { Property, Node } from '@/types/api';
import { Checkbox } from '@/components/core/Checkbox';
import { Dropdown } from '@/components/core/Dropdown';
import { DatePickerPopup } from '@/components/core/DatePickerPopup';
import { NodeSelector } from '@/components/nodes/NodeSelector';
import { TextPropertyBlock } from './TextPropertyBlock';
import { NodeIcon } from '@/components/core/icons';
import { parseIconField } from '@/utils/iconDom';
import { Button } from '@/components/core/Button';
import { getOrCreateDaily } from '@/api/nodes';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import './PropertiesSection.css';

interface PropertyValueProps {
  property: Property;
  nodeId: number;
  value: unknown;
  readOnly?: boolean;
  onChange: (value: unknown) => void;
  onNavigateToNode?: (nodeId: number) => void;
  onCreatePage?: (name: string, additionalClasses?: number[]) => Promise<Node>;
  onOpenInSidebar?: (nodeId: number) => void;
  onPropertyChange: (propertyId: number, value: unknown) => void;
  /** Callback when text property bullet is clicked (opens focused block view) */
  onBulletClick?: (blockId: number) => void;
}

/**
 * Date property value component.
 * Shows the day page name; click opens a hidden date picker to select a new date.
 * The selected date creates/gets the day page and stores its ID as the relation value.
 */
function DatePropertyValue({
  value,
  readOnly,
  onChange,
  onDelete,
}: {
  value: number | null;
  readOnly: boolean;
  onChange: (value: unknown) => void;
  onDelete?: () => void;
}) {
  const { data: dayNode } = useNode(value);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Convert day page UUID (YYYYMMDD) to YYYY-MM-DD for the DatePickerPopup
  const isoValue = useMemo(() => {
    if (!dayNode?.uuid) return '';
    const u = dayNode.uuid;
    if (u.length === 8 && /^\d{8}$/.test(u)) {
      return `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
    }
    return '';
  }, [dayNode?.uuid]);

  const handleSelect = useCallback(async (isoDate: string) => {
    if (!isoDate) {
      onDelete?.();
      return;
    }
    setLoading(true);
    try {
      const newDayNode = await getOrCreateDaily(isoDate);
      onChange(newDayNode.id);
    } catch (err) {
      console.error('Failed to create/get day page:', err);
    } finally {
      setLoading(false);
    }
  }, [onChange, onDelete]);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    if (readOnly || loading) return;
    if (e.shiftKey && value == null) {
      const today = new Date();
      const isoToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      await handleSelect(isoToday);
      return;
    }
    setIsOpen(true);
  }, [readOnly, loading, value, handleSelect]);

  const displayName = dayNode ? nodeNameToText(dayNode.name) : null;

  return (
    <div className="property-value-date-container">
      <button
        ref={anchorRef}
        type="button"
        className="property-value-date-display"
        onClick={handleClick}
        disabled={readOnly || loading}
        title={readOnly ? undefined : 'Click to change date'}
      >
        {loading ? (
          <span className="property-placeholder">Setting…</span>
        ) : displayName ? (
          <span className="property-value-date-name">{displayName}</span>
        ) : (
          <span className="property-placeholder">Empty</span>
        )}
      </button>
      {!readOnly && value != null && (
        <Button
          variant="ghost"
          size="xs"
          className="property-value-date-clear"
          onClick={(e) => { e.stopPropagation(); onDelete?.(); }}
          title="Clear date"
        >
          ×
        </Button>
      )}
      {isOpen && (
        <DatePickerPopup
          value={isoValue}
          onSelect={handleSelect}
          onClose={() => setIsOpen(false)}
          anchorRef={anchorRef}
        />
      )}
    </div>
  );
}

/** Render a URL value as a clickable link */
function UrlPropertyValue({ value, readOnly, onChange, validationRules }: { value: unknown; readOnly: boolean; onChange: (v: unknown) => void; validationRules?: Record<string, unknown> | null }) {
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
          <button type="button" className="property-link-edit" onClick={() => { setEditValue(strValue); setValidationError(null); setIsEditing(true); }} title="Edit URL">✎</button>
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

/** Render an email value as a mailto: link */
function EmailPropertyValue({ value, readOnly, onChange, validationRules }: { value: unknown; readOnly: boolean; onChange: (v: unknown) => void; validationRules?: Record<string, unknown> | null }) {
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
          type="email"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') setIsEditing(false);
          }}
          autoFocus
          className={`property-value-input ${validationError ? 'property-value-input--error' : ''}`}
          placeholder="user@example.com"
        />
        {validationError && <div className="property-validation-error">{validationError}</div>}
      </div>
    );
  }

  if (strValue) {
    return (
      <span className="property-value-url">
        <a href={`mailto:${strValue}`} className="property-link" onClick={e => e.stopPropagation()}>
          {strValue}
        </a>
        {!readOnly && (
          <button type="button" className="property-link-edit" onClick={() => { setEditValue(strValue); setValidationError(null); setIsEditing(true); }} title="Edit email">✎</button>
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

/**
 * Render a property value based on its type
 */
export function PropertyValue({
  property,
  nodeId,
  value,
  readOnly = false,
  onChange,
  onNavigateToNode,
  onCreatePage,
  onOpenInSidebar,
  onPropertyChange,
  onBulletClick
}: PropertyValueProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // Hooks at top level to comply with Rules of Hooks
  const handleCreateNodeForProperty = useCallback(async (name: string): Promise<Node> => {
    const newPage = await onCreatePage?.(name, property.class_filters);
    if (!newPage) throw new Error('Failed to create page');
    return newPage;
  }, [onCreatePage, property.class_filters]);

  const selectionOptions = useMemo(() => {
    const opts = property.options ?? [];
    return opts.map(opt => {
      const color = opt.color || parseIconField(opt.icon || '').color || null;
      return {
        value: opt.id,
        label: opt.name,
        iconNode: color
          ? <span className="selection-color-dot" style={{ background: color }} />
          : opt.icon ? <NodeIcon icon={opt.icon} size="xs" /> : undefined,
      };
    });
  }, [property.options]);

  const commitEdit = useCallback(() => {
    setIsEditing(false);

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
        finalValue = editValue === 'true' || editValue === '1';
        break;
      case 'node':
        finalValue = parseInt(editValue, 10);
        if (isNaN(finalValue as number)) return;
        break;
      case 'url':
      case 'email':
        finalValue = editValue.trim();
        break;
      default:
        finalValue = editValue;
    }

    // Validate against validation_rules if present
    const rules = property.validation_rules;
    if (rules && finalValue != null && finalValue !== '') {
      if (rules.pattern && typeof finalValue === 'string') {
        try {
          if (!new RegExp(String(rules.pattern)).test(finalValue)) {
            setValidationError(`Does not match pattern: ${rules.pattern}`);
            return;
          }
        } catch { /* invalid regex — skip */ }
      }
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

  switch (property.type) {
    case 'boolean':
      return (
        <Checkbox
          size="sm"
          checked={Boolean(value)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.checked)}
        />
      );

    case 'integer':
    case 'float':
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

    case 'text':
      // Text properties are stored as block node references
      // Single: value is a block node ID (number) or null
      // Multi: value is an array of block node IDs (number[])
      // When multi-text is expanded into separate rows, value is a single number
      return (
        <TextPropertyBlock
          property={property}
          nodeId={nodeId}
          blockNodeId={typeof value === 'number' ? value : null}
          blockNodeIds={property.multi && Array.isArray(value) ? value as number[] : undefined}
          readOnly={readOnly}
          onOpenInSidebar={onOpenInSidebar}
          onPropertyChange={onPropertyChange}
          onBulletClick={onBulletClick}
        />
      );

    case 'node':
      // For node references

      if (property.multi) {
        // Multi-value: pill-row mode with add/remove (same as classes/tags)
        return (
          <NodeSelector
            value={value as number[] | null}
            searchMode="pages"
            classFilters={property.class_filters}
            emptyText="Add"
            searchPlaceholder="Search pages..."
            readOnly={readOnly}
            onNodeClick={onNavigateToNode ? (n) => onNavigateToNode(n.id) : undefined}
            onAdd={readOnly ? undefined : (selectedNode) => {
              const currentValue = Array.isArray(value) ? value : (value ? [value] : []);
              onChange([...currentValue, selectedNode.id]);
            }}
            onRemove={readOnly ? undefined : (selectedNode) => {
              const currentValue = Array.isArray(value) ? value : [];
              onChange(currentValue.filter((id: number) => id !== selectedNode.id));
            }}
            onCreateNew={readOnly ? undefined : handleCreateNodeForProperty}
          />
        );
      }

      // Single-value: dropdown select mode
      return (
        <NodeSelector
          trigger="select"
          value={value as number | null}
          searchMode="pages"
          classFilters={property.class_filters}
          placeholder="Empty"
          searchPlaceholder="Search pages..."
          readOnly={readOnly}
          onNodeClick={onNavigateToNode ? (n) => onNavigateToNode(n.id) : undefined}
          onChange={(newValue) => onChange(newValue)}
          onCreateNew={readOnly ? undefined : handleCreateNodeForProperty}
        />
      );

    case 'selection':
      // Selection with options
      if (property.multi) {
        // Multi-value selection: use Dropdown with multiple
        return (
          <Dropdown
            options={selectionOptions}
            values={Array.isArray(value) ? value.map(v => typeof v === 'object' && v !== null && 'id' in v ? (v as { id: number }).id : v) : []}
            onChangeMultiple={(newValues) => onChange(newValues)}
            placeholder="Empty"
            multiple
            searchable
            disabled={readOnly}
            size="sm"
          />
        );
      } else {
        // Single-value selection: use Dropdown
        const currentValue = typeof value === 'object' && value !== null && 'id' in value ? (value as { id: number }).id : value;

        return (
          <Dropdown
            options={selectionOptions}
            value={typeof currentValue === 'number' ? currentValue : null}
            onChange={(newValue) => onChange(newValue)}
            placeholder="Empty"
            searchable
            disabled={readOnly}
            size="sm"
          />
        );
      }

    case 'date':
      // Date property: value is a day page node ID (relation)
      // Display: show day page node name
      // Edit: calendar picker → creates/gets day page → sets node ID
      return (
        <DatePropertyValue
          value={typeof value === 'number' ? value : null}
          readOnly={readOnly}
          onChange={onChange}
          onDelete={!readOnly && value != null ? () => onChange(null) : undefined}
        />
      );

    case 'url':
      return <UrlPropertyValue value={value} readOnly={readOnly} onChange={onChange} validationRules={property.validation_rules} />;

    case 'email':
      return <EmailPropertyValue value={value} readOnly={readOnly} onChange={onChange} validationRules={property.validation_rules} />;

    default:
      return <span className="property-value-unknown">{String(value ?? '')}</span>;
  }
}
