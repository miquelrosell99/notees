import type { Node, Property } from '@/types';
import type { ParsedDate } from '@/utils/dateParser';
import type { FilterPrefixConfig } from '@/utils/searchFilters';

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

// Re-export filter types from shared location
export {
  FILTER_PREFIXES,
  parseQueryWithFilters,
} from '@/utils/searchFilters';

export type {
  FilterPrefixConfig,
  AppliedFilter,
  ParsedFilters,
} from '@/utils/searchFilters';

export type CommandIcon = 'import' | 'export' | 'maintenance' | 'focus' | 'uuid' | 'merge' | 'random' | 'minimap' | 'graph' | 'expand' | 'presentation' | 'share' | 'sync' | 'lock';

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
  parsedDate?: ParsedDate;
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
