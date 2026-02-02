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
  mdiArrowDown,
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
  { value: 'CLASS', label: 'Classes', icon: mdiTagOutline, description: 'Filter by node class' },
  { value: 'CONTENT', label: 'Content', icon: mdiTextBox, description: 'Filter by text content' },
  { value: 'REFERENCE', label: 'References', icon: mdiLink, description: 'Nodes that reference...' },
  { value: 'REFERENCE_PATH', label: 'Path References', icon: mdiLink, description: 'Nodes referenced by path' },
  { value: 'PARENT', label: 'Direct parent', icon: mdiArrowUp, description: 'Has specific parent' },
  { value: 'PARENT_PATH', label: 'Inside page', icon: mdiArrowUp, description: 'Descendant of page' },
  { value: 'CHILD', label: 'Direct child', icon: mdiArrowDown, description: 'Has specific child' },
  { value: 'CHILD_PATH', label: 'Contains', icon: mdiArrowDown, description: 'Has descendant' },
  { value: 'CLASS_PATH', label: 'Inherited class', icon: mdiTagOutline, description: 'Has class from ancestors' },
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
    case 'CLASS':
      return { type, value: '' };
    case 'PROPERTY':
      return {
        type,
        property_name: '',
        property_type: 'text',
        operator: 'equals',
        value: '',
      };
    case 'CONTENT':
      return { type, operator: 'contains', value: '' };
    case 'REFERENCE':
      return { type, target_uuid: '' };
    case 'REFERENCE_PATH':
      return { type, blocks: [] };
    case 'PARENT':
      return { type, blocks: [] };
    case 'PARENT_PATH':
      return { type, blocks: [] };
    case 'CHILD':
      return { type, blocks: [] };
    case 'CHILD_PATH':
      return { type, blocks: [] };
    case 'CLASS_PATH':
      return { type, blocks: [] };
    case 'UUID':
      return { type, value: '' };
    default:
      return { type: 'AND_CONTAINER', blocks: [] };
  }
}

/**
 * Check if a block is a system default block that should be hidden.
 * System blocks use placeholders like {current_node_uuid} or {current_node_id}.
 */
export function isSystemBlock(block: QueryBlock): boolean {
  // Check for placeholder values that indicate system blocks
  if (block.type === 'REFERENCE') {
    const refBlock = block as { target_uuid?: string };
    return refBlock.target_uuid?.startsWith('{') ?? false;
  }
  if (block.type === 'UUID') {
    const uuidBlock = block as { value?: string };
    return uuidBlock.value?.startsWith('{') ?? false;
  }
  if (block.type === 'PARENT_PATH') {
    const parentPathBlock = block as { blocks?: QueryBlock[] };
    // Check if any nested block is a system block
    return parentPathBlock.blocks?.some(b => isSystemBlock(b)) ?? false;
  }
  // Container blocks are system blocks if ALL their children are system blocks
  if (block.type === 'AND_CONTAINER' || block.type === 'OR_CONTAINER') {
    const containerBlock = block as { blocks?: QueryBlock[] };
    if (!containerBlock.blocks || containerBlock.blocks.length === 0) return false;
    return containerBlock.blocks.every(b => isSystemBlock(b));
  }
  return false;
}
