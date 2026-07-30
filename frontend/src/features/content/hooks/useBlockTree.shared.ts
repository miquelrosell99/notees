import type { Node } from '@/types/api';

export interface FlatNode {
  node: Node;
  depth: number;
  effectiveCollapsed: boolean;
  /** True for the trailing pseudo-block used to create new blocks in place. */
  isGhost?: boolean;
}

export interface UseBlockTreeOptions {
  maxDepth?: number;
  pagesOnly?: boolean;
  skipPages?: boolean;
  expandAll?: boolean;
  nodeUuid?: string;
  /** If false (default), a ghost block is appended as the last sibling. */
  readOnly?: boolean;
  /** If false, no ghost pseudo-blocks are generated regardless of readOnly. */
  showNewBlock?: boolean;
  /** If true, the root container is a block (focused block view), so the trailing
   *  root ghost is indented one level deeper and the per-parent child ghost for the
   *  root node is suppressed to avoid a duplicate placeholder. */
  rootIsBlock?: boolean;
}

const GHOST_PREFIX = '__ghost-';

export function isGhostId(uuid: string): boolean {
  return uuid.startsWith(GHOST_PREFIX);
}

export function buildGhostId(parentUuid: string): string {
  return `${GHOST_PREFIX}${parentUuid}`;
}

export function parseGhostParentUuid(ghostUuid: string): string | null {
  if (!isGhostId(ghostUuid)) return null;
  return ghostUuid.slice(GHOST_PREFIX.length);
}

export function isValidServerNodeId(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

export function createGhostFlatNode(parentUuid: string, depth: number): FlatNode {
  return {
    node: {
      uuid: buildGhostId(parentUuid),
      name: '',
      icon: null,
      color: null,
      parent_uuid: null,
      page_uuid: null,
      sequence: Number.MAX_SAFE_INTEGER,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: false,
      children: [],
      create_date: '',
      write_date: '',
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    },
    depth,
    effectiveCollapsed: false,
    isGhost: true,
  };
}
