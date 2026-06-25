import type { Node } from '@/types';

export type NodeSearchMode = 'all' | 'pages' | 'blocks' | 'classes' | 'tags' | 'aliases' | 'users';

export interface NodeSearchFilters {
  /** What types of nodes to include */
  mode?: NodeSearchMode;
  /** Class IDs to filter by (nodes must have at least one of these classes) */
  classFilters?: number[];
  /** Node ID to exclude from results (e.g., self-reference) */
  excludeNodeId?: number;
  /** Maximum number of results per section */
  maxResults?: number;
  /** Node ID to pin at the top of results (current value in single-select pickers) */
  pinnedNodeId?: number | null;
  /** Node UUID to search for directly */
  nodeUuid?: string;
  /** Filter to pages only */
  isPage?: boolean;
  /** Filter to class definitions */
  isClass?: boolean;
  /** Filter to daily notes */
  isDaily?: boolean;
  /** Filter to user pages (for @mentions) */
  isUserPage?: boolean;
}

export interface NodeSearchItem {
  node: Node;
  section: 'page' | 'block' | 'class';
}

export interface UseNodeSearchReturn {
  /** Page/type results */
  pageResults: NodeSearchItem[];
  /** Block results */
  blockResults: NodeSearchItem[];
  /** All results combined (pages first, then blocks) */
  allResults: NodeSearchItem[];
  /** Whether the search is loading */
  isLoading: boolean;
  /** Whether to show "Create new" option */
  showCreateOption: boolean;
  /** Whether more results were available but truncated by maxResults */
  hasMore: boolean;
}
