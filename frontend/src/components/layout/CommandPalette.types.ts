import type { Node, Property } from '@/types';

export interface CommandPaletteProps {
  /** Whether the palette is open */
  isOpen: boolean;
  /** Callback to close the palette */
  onClose: () => void;
  /** Callback when a node is selected */
  onSelect?: (node: Node) => void;
}

export interface SearchResult {
  node?: Node;
  property?: Property;
  type: 'page' | 'block' | 'property';
  breadcrumb?: string;
}

/**
 * Filter prefix configuration for the command palette.
 * Supports: class dropdown, text input (uuid), and boolean dropdowns.
 */
export interface FilterPrefixConfig {
  prefix: string;
  label: string;
  description: string;
  type: 'class' | 'text' | 'boolean';
  options?: string[]; // For boolean type
}

export const FILTER_PREFIXES: FilterPrefixConfig[] = [
  { prefix: 'uuid', label: 'UUID', description: 'Find node by UUID', type: 'text' },
  { prefix: 'class', label: 'Class', description: 'Filter by class', type: 'class' },
  { prefix: 'is_page', label: 'Is Page', description: 'Filter pages or blocks', type: 'boolean', options: ['true', 'false'] },
  { prefix: 'is_class', label: 'Is Class', description: 'Filter class definitions', type: 'boolean', options: ['true', 'false'] },
  { prefix: 'is_daily', label: 'Is Daily', description: 'Filter daily notes', type: 'boolean', options: ['true', 'false'] },
];

/** An applied filter (shown as a pill below the input) */
export type AppliedFilter =
  | { type: 'class'; classNode: Node }
  | { type: 'boolean'; prefix: string; label: string; value: boolean };

export interface ParsedFilters {
  /** Remaining search text after removing filter syntax */
  searchTerm: string;
  /** Active filter being typed (prefix:value in progress) */
  activeFilter: { prefix: string; value: string; config: FilterPrefixConfig } | null;
  /** Whether user is actively typing a filter value */
  isTypingFilter: boolean;
  /** Matching prefix suggestions (when user types partial prefix without colon) */
  suggestedPrefixes: FilterPrefixConfig[];
  /** UUID being searched for (when query is uuid:value) */
  uuidSearch: string | null;
}

export type CommandIcon = 'import' | 'export' | 'maintenance' | 'focus' | 'uuid' | 'merge' | 'random' | 'minimap' | 'graph' | 'expand';

export interface CommandDef {
  id: string;
  label: string;
  icon: CommandIcon;
  requiresPage?: boolean;
  devOnly?: boolean;
}

export interface DuplicateModalState {
  isOpen: boolean;
  pageName: string;
  conflictingClasses: string[];
  originalClasses: number[];
  parentId: number | null;
}

// Initial items shown per section — expandable via "Show more"
export const INITIAL_MAX_PAGES = 8;
export const INITIAL_MAX_BLOCKS = 8;
export const INITIAL_MAX_PROPERTIES = 5;
export const EXPAND_INCREMENT = 20;

export interface ItemEntry {
  type: 'page' | 'block' | 'property' | 'add-page' | 'quick-add' | 'date' | 'command' | 'browse-page' | 'show-more' | 'filter-prefix' | 'boolean-option';
  result?: SearchResult;
  label?: string;
  parsedDate?: import('@/utils/dateParser').ParsedDate;
  existingNode?: Node;
  commandId?: string;
  commandIcon?: CommandIcon;
  commandDevOnly?: boolean;
  browseSection?: 'recent-accessed' | 'recent-created' | 'random';
  showMoreSection?: 'pages' | 'blocks' | 'properties';
  showMoreCount?: number;
  filterPrefix?: FilterPrefixConfig;
  booleanValue?: boolean;
}

export interface GroupedItems {
  dateItems: ItemEntry[];
  pageItems: ItemEntry[];
  blockItems: ItemEntry[];
  propertyItems: ItemEntry[];
  quickAddItems: ItemEntry[];
  commandItems: ItemEntry[];
  filterPrefixItems: ItemEntry[];
  booleanOptionItems: ItemEntry[];
  browseRecentAccessed: ItemEntry[];
  browseRecentCreated: ItemEntry[];
  browseRandom: ItemEntry[];
  indexMap: Map<ItemEntry, number>;
}
