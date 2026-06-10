/**
 * Property Value Renderers
 *
 * All property-type-specific renderers in one module.
 * Each renderer is registered in the Property Value Registry via
 * registerPropertyRenderers.ts.
 */

/* eslint-disable react-refresh/only-export-components */

import { useState, useCallback, useMemo } from 'react';
import { Dropdown } from '@/components/core/Dropdown';
import { NodeSelector } from '@/components/nodes/NodeSelector';
import { TextPropertyBlock } from '../TextPropertyBlock';
import { DatePropertyValue } from '../DatePropertyValue';
import { UrlPropertyValue } from '../UrlPropertyValue';
import { EmailPropertyValue } from '../EmailPropertyValue';
import { NodeIcon } from '@/components/core/icons';
import { parseIconField } from '@/utils/iconDom';
import type { PropertyValueProps } from '../propertyValueRegistry';
import type { Property } from '@/types/api';

// ==================== Boolean ====================

export function BooleanPropertyValue(_props: Pick<PropertyValueProps, 'value' | 'readOnly' | 'onChange'>) {
  // Rendered via Checkbox in the registry registration file.
  // This component is a no-op placeholder. Kept for registry completeness.
  return null;
}

export function booleanGetDefaultValue(): unknown {
  return false;
}

export function booleanFormatValue(value: unknown): string {
  return value ? '✓' : '';
}

export function booleanGetGroupInfo(_property: Property, rawValue: unknown): { label: string; icon: string | null } {
  return { label: rawValue ? 'Yes' : 'No', icon: null };
}

export function booleanCompareValues(a: unknown, b: unknown): number {
  return (a ? 1 : 0) - (b ? 1 : 0);
}

// ==================== Number (integer / float) ====================

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

export function numberGetDefaultValue(): unknown {
  return 0;
}

export function numberFormatValue(value: unknown): string {
  return String(value ?? '');
}

export function numberGetGroupInfo(_property: Property, rawValue: unknown): { label: string; icon: string | null } {
  return { label: String(rawValue), icon: null };
}

export function numberCompareValues(a: unknown, b: unknown): number {
  return (a as number) - (b as number);
}

// ==================== Text ====================

export function TextPropertyValue({
  property,
  nodeId,
  value,
  readOnly,
  onOpenInSidebar,
  onPropertyChange,
  onBulletClick,
}: PropertyValueProps) {
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
}

export function textGetDefaultValue(): unknown {
  return '';
}

export function textFormatValue(_value: unknown): string {
  return '';
}

export function textGetGroupInfo(_property: Property, rawValue: unknown): { label: string; icon: string | null } {
  return { label: String(rawValue ?? '(No value)'), icon: null };
}

export function textCompareValues(a: unknown, b: unknown): number {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

// ==================== Node ====================

export function NodePropertyValue({
  property,
  value,
  readOnly,
  onChange,
  onNavigateToNode,
  onCreatePage,
}: PropertyValueProps) {
  const handleCreateNodeForProperty = useCallback(async (name: string) => {
    const newPage = await onCreatePage?.(name, property.class_filters);
    if (!newPage) throw new Error('Failed to create page');
    return newPage;
  }, [onCreatePage, property.class_filters]);

  if (property.multi) {
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
}

export function nodeGetDefaultValue(): unknown {
  return null;
}

export function nodeFormatValue(_value: unknown): string {
  return '';
}

export function nodeGetGroupInfo(_property: Property, rawValue: unknown): { label: string; icon: string | null } {
  return {
    label: Array.isArray(rawValue) ? rawValue.map(String).join(', ') : String(rawValue ?? '(No value)'),
    icon: null,
  };
}

export function nodeCompareValues(a: unknown, b: unknown): number {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

// ==================== Selection ====================

export function SelectionPropertyValue({
  property,
  value,
  readOnly,
  onChange,
}: PropertyValueProps) {
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

  if (property.multi) {
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
  }

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

export function selectionGetDefaultValue(): unknown {
  return '';
}

export function selectionFormatValue(_value: unknown): string {
  return '';
}

export function selectionGetGroupInfo(property: Property, rawValue: unknown): { label: string; icon: string | null } {
  const resolveId = (v: unknown): number | null => {
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && v !== null && 'id' in v) return (v as { id: number }).id;
    return null;
  };
  if (Array.isArray(rawValue)) {
    const opts = rawValue
      .map(resolveId)
      .filter((id): id is number => id !== null)
      .map(id => property.options?.find(o => o.id === id));
    const names = opts.map(o => o?.name ?? '?').join(', ');
    const icon = opts.length === 1 ? (opts[0]?.icon ?? null) : null;
    return { label: names || '(No value)', icon };
  }
  const optId = resolveId(rawValue);
  if (optId === null) return { label: String(rawValue), icon: null };
  const opt = property.options?.find(o => o.id === optId);
  return { label: opt?.name ?? String(optId), icon: opt?.icon ?? null };
}

export function selectionCompareValues(a: unknown, b: unknown, property: Property): number {
  const getOptionName = (v: unknown): string => {
    if (typeof v === 'number') {
      return property.options?.find(o => o.id === v)?.name ?? String(v);
    }
    if (v && typeof v === 'object' && 'id' in v) {
      return property.options?.find(o => o.id === (v as { id: number }).id)?.name ?? String(v);
    }
    return String(v);
  };
  return getOptionName(a).localeCompare(getOptionName(b));
}

// ==================== Date ====================

export function DatePropertyValueRenderer({
  value,
  readOnly = false,
  onChange,
}: Pick<PropertyValueProps, 'value' | 'readOnly' | 'onChange'> & { readOnly?: boolean }) {
  return (
    <DatePropertyValue
      value={typeof value === 'number' ? value : null}
      readOnly={readOnly}
      onChange={onChange}
      onDelete={!readOnly && value != null ? () => onChange(null) : undefined}
    />
  );
}

export function dateGetDefaultValue(): unknown {
  return null;
}

export function dateFormatValue(_value: unknown): string {
  return '';
}

export function dateGetGroupInfo(_property: Property, rawValue: unknown): { label: string; icon: string | null } {
  return { label: String(rawValue ?? '(No value)'), icon: null };
}

export function dateCompareValues(a: unknown, b: unknown): number {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

// ==================== URL ====================

export function UrlPropertyValueRenderer({
  value,
  readOnly = false,
  onChange,
  property,
}: PropertyValueProps) {
  return (
    <UrlPropertyValue
      value={value}
      readOnly={readOnly}
      onChange={onChange}
      validationRules={property.validation_rules}
    />
  );
}

export function urlGetDefaultValue(): unknown {
  return '';
}

export function urlFormatValue(_value: unknown): string {
  return '';
}

export function urlGetGroupInfo(_property: Property, rawValue: unknown): { label: string; icon: string | null } {
  return { label: String(rawValue ?? '(No value)'), icon: null };
}

export function urlCompareValues(a: unknown, b: unknown): number {
  return String(a ?? '').localeCompare(String(b ?? ''));
}

// ==================== Email ====================

export function EmailPropertyValueRenderer({
  value,
  readOnly = false,
  onChange,
  property,
}: PropertyValueProps) {
  return (
    <EmailPropertyValue
      value={value}
      readOnly={readOnly}
      onChange={onChange}
      validationRules={property.validation_rules}
    />
  );
}

export function emailGetDefaultValue(): unknown {
  return '';
}

export function emailFormatValue(_value: unknown): string {
  return '';
}

export function emailGetGroupInfo(_property: Property, rawValue: unknown): { label: string; icon: string | null } {
  return { label: String(rawValue ?? '(No value)'), icon: null };
}

export function emailCompareValues(a: unknown, b: unknown): number {
  return String(a ?? '').localeCompare(String(b ?? ''));
}
