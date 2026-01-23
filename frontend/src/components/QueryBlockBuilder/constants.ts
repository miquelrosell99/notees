/**
 * QueryBlockBuilder Constants
 * 
 * Shared constants, types, and helper functions for the query builder.
 */
import {
  mdiSetAll,
  mdiSetCenter,
  mdiTagOutline,
  mdiTextBox,
  mdiLink,
  mdiArrowUp,
  mdiCodeBraces,
  mdiCancel,
  mdiFormatListBulleted,
  mdiMagnify,
} from '@mdi/js';
import type { SelectionButtonOption } from '../core/SelectionButton';
import type {
  QueryBlock,
  QueryBlockType,
} from '@/types/query';

// ==================== Root Logic Options ====================

export const ROOT_LOGIC_OPTIONS: SelectionButtonOption[] = [
  { value: 'AND_CONTAINER', icon: mdiSetAll, label: 'Match ALL conditions' },
  { value: 'OR_CONTAINER', icon: mdiSetCenter, label: 'Match ANY condition' },
];

// ==================== Filter Type Options ====================

export interface FilterTypeOption {
  value: QueryBlockType;
  label: string;
  icon: string;
  description: string;
}

export const FILTER_TYPE_OPTIONS: FilterTypeOption[] = [
  { value: 'TYPE', label: 'Type', icon: mdiTagOutline, description: 'Filter by node type' },
  { value: 'CONTENT', label: 'Content', icon: mdiTextBox, description: 'Filter by text content' },
  { value: 'REFERENCE', label: 'References', icon: mdiLink, description: 'Nodes that reference...' },
  { value: 'ANCESTOR_PATH', label: 'Inside page', icon: mdiArrowUp, description: 'Descendant of page' },
  { value: 'PROPERTY', label: 'Property', icon: mdiCodeBraces, description: 'Filter by property value' },
  { value: 'AND_CONTAINER', label: 'All of (AND)', icon: mdiSetAll, description: 'Match all nested conditions' },
  { value: 'OR_CONTAINER', label: 'Any of (OR)', icon: mdiSetCenter, description: 'Match any nested condition' },
  { value: 'NOT_CONTAINER', label: 'Exclude (NOT)', icon: mdiCancel, description: 'Exclude matching nodes' },
];

// ==================== Operators ====================

export const TYPE_OPERATORS = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'is_any', label: 'is any of' },
];

export const CONTENT_OPERATORS = [
  { value: 'contains', label: 'contains' },
  { value: '=', label: 'equals' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'fts', label: 'search (full-text)' },
];

export const PROPERTY_TEXT_OPERATORS = [
  { value: '=', label: 'equals' },
  { value: '!=', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

export const PROPERTY_NUMBER_OPERATORS = [
  { value: '=', label: 'equals' },
  { value: '!=', label: 'not equals' },
  { value: '>', label: 'greater than' },
  { value: '>=', label: 'greater or equal' },
  { value: '<', label: 'less than' },
  { value: '<=', label: 'less or equal' },
];

export const PROPERTY_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'integer', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'selection', label: 'Selection' },
  { value: 'node', label: 'Node' },
  { value: 'date', label: 'Date' },
];

// ==================== Value Mode Options ====================

export const VALUE_MODE_OPTIONS: SelectionButtonOption[] = [
  { value: 'static', icon: mdiFormatListBulleted, label: 'Select values' },
  { value: 'dynamic', icon: mdiMagnify, label: 'Dynamic query' },
];

// ==================== Helper Functions ====================

export function createDefaultBlock(type: QueryBlockType): QueryBlock {
  switch (type) {
    case 'AND_CONTAINER':
    case 'OR_CONTAINER':
      return { type, blocks: [] };
    case 'NOT_CONTAINER':
      return { type, block: undefined };
    case 'TYPE':
      return { type, value: '' };
    case 'PROPERTY':
      return {
        type,
        property_name: '',
        property_type: 'text',
        operator: '=',
        value: '',
      };
    case 'CONTENT':
      return { type, operator: 'contains', value: '' };
    case 'REFERENCE':
      return { type, target_uuid: '' };
    case 'REFERENCE_PATH':
      return { type, blocks: [] };
    case 'ANCESTOR_PATH':
      return { type, blocks: [] };
    case 'UUID':
      return { type, value: '' };
    default:
      return { type: 'AND_CONTAINER', blocks: [] };
  }
}
