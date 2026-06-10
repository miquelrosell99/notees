/**
 * Property Value Renderer Registration
 *
 * Eagerly imports and registers all property value renderers.
 * This file must be imported before any code that calls
 * getPropertyValueRenderer().
 */

import { registerPropertyValueRenderer } from './propertyValueRegistry';
import {
  // Components
  NumberPropertyValue,
  TextPropertyValue,
  NodePropertyValue,
  SelectionPropertyValue,
  DatePropertyValueRenderer,
  UrlPropertyValueRenderer,
  EmailPropertyValueRenderer,
  // Logic
  booleanGetDefaultValue,
  booleanFormatValue,
  booleanGetGroupInfo,
  booleanCompareValues,
  numberGetDefaultValue,
  numberFormatValue,
  numberGetGroupInfo,
  numberCompareValues,
  textGetDefaultValue,
  textFormatValue,
  textGetGroupInfo,
  textCompareValues,
  nodeGetDefaultValue,
  nodeFormatValue,
  nodeGetGroupInfo,
  nodeCompareValues,
  selectionGetDefaultValue,
  selectionFormatValue,
  selectionGetGroupInfo,
  selectionCompareValues,
  dateGetDefaultValue,
  dateFormatValue,
  dateGetGroupInfo,
  dateCompareValues,
  urlGetDefaultValue,
  urlFormatValue,
  urlGetGroupInfo,
  urlCompareValues,
  emailGetDefaultValue,
  emailFormatValue,
  emailGetGroupInfo,
  emailCompareValues,
} from './renderers/PropertyRenderers';
import { Checkbox } from '@/components/core/Checkbox';
import type { PropertyValueProps } from './propertyValueRegistry';

// ==================== Boolean ====================

registerPropertyValueRenderer({
  type: 'boolean',
  label: 'Boolean',
  icon: 'toggle-switch',
  component: function BooleanRenderer({ value, readOnly, onChange }: PropertyValueProps) {
    return (
      <Checkbox
        size="sm"
        checked={Boolean(value)}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  },
  getDefaultValue: booleanGetDefaultValue,
  formatValue: booleanFormatValue,
  getGroupInfo: booleanGetGroupInfo,
  compareValues: booleanCompareValues,
});

// ==================== Integer ====================

registerPropertyValueRenderer({
  type: 'integer',
  label: 'Integer',
  icon: 'numeric',
  component: NumberPropertyValue,
  getDefaultValue: numberGetDefaultValue,
  formatValue: numberFormatValue,
  getGroupInfo: numberGetGroupInfo,
  compareValues: numberCompareValues,
});

// ==================== Float ====================

registerPropertyValueRenderer({
  type: 'float',
  label: 'Float',
  icon: 'decimal',
  component: NumberPropertyValue,
  getDefaultValue: numberGetDefaultValue,
  formatValue: numberFormatValue,
  getGroupInfo: numberGetGroupInfo,
  compareValues: numberCompareValues,
});

// ==================== Text ====================

registerPropertyValueRenderer({
  type: 'text',
  label: 'Text',
  icon: 'text',
  component: TextPropertyValue,
  getDefaultValue: textGetDefaultValue,
  formatValue: textFormatValue,
  getGroupInfo: textGetGroupInfo,
  compareValues: textCompareValues,
});

// ==================== Node ====================

registerPropertyValueRenderer({
  type: 'node',
  label: 'Node',
  icon: 'link',
  component: NodePropertyValue,
  getDefaultValue: nodeGetDefaultValue,
  formatValue: nodeFormatValue,
  getGroupInfo: nodeGetGroupInfo,
  compareValues: nodeCompareValues,
});

// ==================== Selection ====================

registerPropertyValueRenderer({
  type: 'selection',
  label: 'Selection',
  icon: 'format-list-bulleted',
  component: SelectionPropertyValue,
  getDefaultValue: selectionGetDefaultValue,
  formatValue: selectionFormatValue,
  getGroupInfo: selectionGetGroupInfo,
  compareValues: selectionCompareValues,
});

// ==================== Date ====================

registerPropertyValueRenderer({
  type: 'date',
  label: 'Date',
  icon: 'calendar',
  component: DatePropertyValueRenderer,
  getDefaultValue: dateGetDefaultValue,
  formatValue: dateFormatValue,
  getGroupInfo: dateGetGroupInfo,
  compareValues: dateCompareValues,
});

// ==================== URL ====================

registerPropertyValueRenderer({
  type: 'url',
  label: 'URL',
  icon: 'link-variant',
  component: UrlPropertyValueRenderer,
  getDefaultValue: urlGetDefaultValue,
  formatValue: urlFormatValue,
  getGroupInfo: urlGetGroupInfo,
  compareValues: urlCompareValues,
});

// ==================== Email ====================

registerPropertyValueRenderer({
  type: 'email',
  label: 'Email',
  icon: 'email',
  component: EmailPropertyValueRenderer,
  getDefaultValue: emailGetDefaultValue,
  formatValue: emailFormatValue,
  getGroupInfo: emailGetGroupInfo,
  compareValues: emailCompareValues,
});

// ==================== Image ====================

registerPropertyValueRenderer({
  type: 'image',
  label: 'Image',
  icon: 'image',
  component: function ImageRenderer({ value }: PropertyValueProps) {
    // Image properties are rendered via PropertyCell/ImageNode
    // Inline rendering falls back to unknown value display
    return <span className="property-value-unknown">{String(value ?? '')}</span>;
  },
  getDefaultValue: () => null,
  formatValue: () => '',
  getGroupInfo: (_property, rawValue) => ({ label: String(rawValue ?? '(No value)'), icon: null }),
  compareValues: (a, b) => String(a ?? '').localeCompare(String(b ?? '')),
});
