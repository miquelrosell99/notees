/**
 * Property Value Renderers
 *
 * All property-type-specific renderers in one module.
 * Each renderer is registered in the Property Value Registry via
 * registerPropertyRenderers.ts.
 */

/* eslint-disable react-refresh/only-export-components */

import { useState, useCallback, useMemo } from 'react';
import { Dropdown } from '@/components/ui/Dropdown';
import { NodeSelector } from '@/features/content';
import { TextPropertyBlock } from '../../components/TextPropertyBlock';
import { DatePropertyValue } from '../../components/DatePropertyValue';
import { DateRangePicker } from '../../components/DateRangePicker';
import { UrlPropertyValue } from '../../components/UrlPropertyValue';
import { EmailPropertyValue } from '../../components/EmailPropertyValue';
import { NodeIcon } from '@/components/ui/icons';
import { parseIconField } from '@/utils/iconDom';
import { formatDateRange, type DateRangeValue } from '@/utils/dateRange';
import type { PropertyValueProps } from '../../utils/propertyValueRegistry';
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
      nodeUuid,
      value,
      readOnly,
      onOpenInSidebar,
      onPropertyChange,
      onBulletClick }: PropertyValueProps) {
  return (
    <TextPropertyBlock
      property={property}
      nodeUuid={nodeUuid}
      blockNodeId={typeof value === 'string' ? value : null}
      blockNodeIds={property.multi && Array.isArray(value) ? value as string[] : undefined}
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
    const newPage = await onCreatePage?.(name, property.class_filter_uuids ?? []);
    if (!newPage) throw new Error('Failed to create page');
    return newPage;
  }, [onCreatePage, property.class_filter_uuids]);

  if (property.multi) {
    return (
      <NodeSelector
        value={value as string[] | null}
        searchMode="pages"
        classFilters={property.class_filter_uuids ?? []}
        emptyText="Add"
        searchPlaceholder="Search pages..."
        readOnly={readOnly}
        onNodeClick={onNavigateToNode ? (n) => onNavigateToNode(n.uuid) : undefined}
        onAdd={readOnly ? undefined : (selectedNode) => {
          const currentValue = Array.isArray(value) ? value : (value ? [value] : []);
          onChange([...currentValue, selectedNode.uuid]);
        }}
        onRemove={readOnly ? undefined : (selectedNode) => {
          const currentValue = Array.isArray(value) ? value : [];
          onChange(currentValue.filter((nodeUuid: string) => nodeUuid !== selectedNode.uuid));
        }}
        onCreateNew={readOnly ? undefined : handleCreateNodeForProperty}
      />
    );
  }

  return (
    <NodeSelector
      trigger="select"
      value={value as string | null}
      searchMode="pages"
      classFilters={property.class_filter_uuids ?? []}
      placeholder="Empty"
      searchPlaceholder="Search pages..."
      readOnly={readOnly}
      onNodeClick={onNavigateToNode ? (n) => onNavigateToNode(n.uuid) : undefined}
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
        value: opt.uuid,
        label: opt.name,
        iconNode: color
          ? <span className="selection-color-dot" style={{ background: color }} />
          : opt.icon ? <NodeIcon icon={opt.icon} size="xs" /> : undefined,
      };
    });
  }, [property.options]);

  const resolveSelectionUuid = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null && 'uuid' in v) return (v as { uuid: string }).uuid;
    return null;
  };

  if (property.multi) {
    return (
      <Dropdown
        options={selectionOptions}
        values={Array.isArray(value) ? value.map(v => resolveSelectionUuid(v)).filter((uuid): uuid is string => !!uuid) : []}
        onChangeMultiple={(newValues) => onChange(newValues)}
        placeholder="Empty"
        multiple
        searchable
        disabled={readOnly}
        size="sm"
      />
    );
  }

  const currentValue = resolveSelectionUuid(value);
  return (
    <Dropdown
      options={selectionOptions}
      value={currentValue}
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
  const resolveId = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null && 'uuid' in v) return (v as { uuid: string }).uuid;
    return null;
  };
  if (Array.isArray(rawValue)) {
    const opts = rawValue
      .map(resolveId)
      .filter((id): id is string => id !== null)
      .map(id => property.options?.find(o => o.uuid === id));
    const names = opts.map(o => o?.name ?? '?').join(', ');
    const icon = opts.length === 1 ? (opts[0]?.icon ?? null) : null;
    return { label: names || '(No value)', icon };
  }
  const optId = resolveId(rawValue);
  if (optId === null) return { label: String(rawValue), icon: null };
  const opt = property.options?.find(o => o.uuid === optId);
  return { label: opt?.name ?? String(optId), icon: opt?.icon ?? null };
}

export function selectionCompareValues(a: unknown, b: unknown, property: Property): number {
  const getOptionName = (v: unknown): string => {
    if (typeof v === 'string') {
      return property.options?.find(o => o.uuid === v)?.name ?? String(v);
    }
    if (v && typeof v === 'object' && 'uuid' in v) {
      return property.options?.find(o => o.uuid === (v as { uuid: string }).uuid)?.name ?? String(v);
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
      value={typeof value === 'string' ? value : null}
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

// ==================== Date Range ====================

export function DateRangePropertyValueRenderer({
  value,
  readOnly = false,
  onChange,
}: Pick<PropertyValueProps, 'value' | 'readOnly' | 'onChange'> & { readOnly?: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const normalized = value && typeof value === 'object' ? (value as DateRangeValue) : null;

  return (
    <>
      <button
        type="button"
        className="property-value-date-range-display"
        onClick={() => { if (!readOnly) setIsOpen(true); }}
        disabled={readOnly}
        title={readOnly ? undefined : 'Click to change date range'}
      >
        {normalized ? (
          <span>{formatDateRange(normalized)}</span>
        ) : (
          <span className="property-placeholder">Empty</span>
        )}
      </button>
      {isOpen && (
        <DateRangePicker
          initialValue={normalized}
          onChange={(newValue) => onChange(newValue)}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
}

export function dateRangeGetDefaultValue(): unknown {
  return null;
}

export function dateRangeFormatValue(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  try {
    return formatDateRange(value as DateRangeValue);
  } catch {
    return '';
  }
}

export function dateRangeGetGroupInfo(_property: Property, rawValue: unknown): { label: string; icon: string | null } {
  return { label: dateRangeFormatValue(rawValue) || '(No value)', icon: null };
}

export function dateRangeCompareValues(a: unknown, b: unknown): number {
  return String(dateRangeFormatValue(a)).localeCompare(String(dateRangeFormatValue(b)));
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
