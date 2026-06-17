/**
 * Query Keys for React Query
 * 
 * Centralized key factories for all node and property queries.
 * Use these consistently for cache invalidation and query matching.
 */

// Fast numeric hash for large ID arrays (avoids spreading 4000+ IDs into query keys)
function hashNumberArray(ids: number[]): number {
  let hash = ids.length;
  for (let i = 0; i < ids.length; i++) {
    hash = ((hash << 5) - hash + ids[i]) | 0;
  }
  return hash;
}

// ==================== Node Query Keys ====================

export const nodeKeys = {
  all: ['nodes'] as const,
  lists: () => [...nodeKeys.all, 'list'] as const,
  list: (filters: { pages_only?: boolean; parent_id?: number; tag_id?: number }) => 
    [...nodeKeys.lists(), filters] as const,
  details: () => [...nodeKeys.all, 'detail'] as const,
  detail: (id: number, options?: { include_children?: boolean; include_backlinks?: boolean; include_properties?: boolean }) => 
    [...nodeKeys.details(), id, options ?? {}] as const,
  // Use this for cache invalidation - matches all detail queries for a node regardless of options
  detailBase: (id: number) => [...nodeKeys.details(), id] as const,
  byUuid: (uuid: string) => [...nodeKeys.all, 'uuid', uuid] as const,
  pageContent: (id: number) => [...nodeKeys.all, 'page-content', id] as const,
  backlinks: (id: number) => [...nodeKeys.all, 'backlinks', id] as const,
  allBacklinks: () => [...nodeKeys.all, 'backlinks'] as const,
  linkedRefs: (id: number, params?: { limit?: number; offset?: number }) =>
    [...nodeKeys.all, 'linked-refs', id, params ?? {}] as const,
  allLinkedRefs: () => [...nodeKeys.all, 'linked-refs'] as const,
  mentions: (id: number) => [...nodeKeys.all, 'mentions', id] as const,
  allMentions: () => [...nodeKeys.all, 'mentions'] as const,
  propertyBacklinks: (id: number) => [...nodeKeys.all, 'property-backlinks', id] as const,
  allPropertyBacklinks: () => [...nodeKeys.all, 'property-backlinks'] as const,
  dailyList: () => [...nodeKeys.all, 'daily-list'] as const,
  daily: (date: string) => [...nodeKeys.all, 'daily', date] as const,
  monthly: (year: number, month: number) => [...nodeKeys.all, 'monthly', year, month] as const,
  yearly: (year: number) => [...nodeKeys.all, 'yearly', year] as const,
  search: (query: string, filters?: Record<string, string | boolean | undefined>) => [...nodeKeys.all, 'search', query, filters ?? {}] as const,
  searchAll: () => [...nodeKeys.all, 'search'] as const,
  breadcrumbsAll: () => [...nodeKeys.all, 'breadcrumbs'] as const,
  classSearch: (query: string) => [...nodeKeys.classes(), 'search', query] as const,
  pages: (options?: { includeChildren?: boolean; rootOnly?: boolean }) => 
    [...nodeKeys.all, 'pages', options ?? {}] as const,
  allPages: () => [...nodeKeys.all, 'pages'] as const,
  filteredPages: (classFiltersParam?: string) => [...nodeKeys.all, 'filtered-pages', classFiltersParam] as const,
  tags: () => [...nodeKeys.all, 'tags'] as const,
  classes: () => [...nodeKeys.all, 'classes'] as const,
  tasks: (includeComplete?: boolean) => [...nodeKeys.all, 'tasks', { includeComplete }] as const,
  graph: () => [...nodeKeys.all, 'graph'] as const,
  graphNodes: () => [...nodeKeys.all, 'graph-nodes'] as const,
  graphLinks: (nodeIds: number[], scope?: string, cooccurrence?: boolean, contextNodeId?: number | null) => [...nodeKeys.all, 'graph-links', scope ?? 'between', cooccurrence ?? false, contextNodeId ?? 'none', nodeIds.length, hashNumberArray(nodeIds)] as const,
  
  // PERFORMANCE: Metadata-only keys for lightweight queries
  // These are separate from detail queries to avoid cache pollution
  metadata: (id: number) => [...nodeKeys.all, 'metadata', id] as const,
  childrenOnly: (id: number) => [...nodeKeys.all, 'children-only', id] as const,
  breadcrumbs: (id: number) => [...nodeKeys.all, 'breadcrumbs', id] as const,
  batchGet: (ids: number[]) => [...nodeKeys.all, 'batch-get', ...ids.sort()] as const,
  batchProperties: (ids: number[]) => [...nodeKeys.all, 'batch-properties', ...ids.sort()] as const,
  suggestions: (classFilters?: string) => [...nodeKeys.all, 'suggestions', classFilters ?? ''] as const,
  aliases: (id: number) => [...nodeKeys.all, 'aliases', id] as const,
  // Prefix keys for cache-wide invalidation (match all regardless of ID)
  archived: () => [...nodeKeys.all, 'archived'] as const,
  byClass: (classId: number) => [...nodeKeys.all, 'by-class', classId] as const,
  byTag: (tagId: number) => [...nodeKeys.all, 'by-tag', tagId] as const,
  textLinks: (nodeId: number) => ['textLinks', nodeId] as const,
  inlineClasses: (nodeId: number) => ['inlineClasses', nodeId] as const,
  pageContents: () => [...nodeKeys.all, 'page-content'] as const,
  uuids: () => [...nodeKeys.all, 'uuid'] as const,
  pseudoNodeQuery: () => ['pseudo-node-query'] as const,
  inlineQuery: () => ['inline-query'] as const,
  tabBatch: (nodeIds: number[]) => [...nodeKeys.all, 'tab-batch', ...nodeIds.sort((a, b) => a - b)] as const,
  ganttDayNodes: (ids: number[]) => [...nodeKeys.all, 'gantt-day-nodes', hashNumberArray(ids)] as const,
};

// ==================== NodeView Query Keys ====================

export const nodeViewKeys = {
  all: ['nodeViews'] as const,
  lists: () => [...nodeViewKeys.all, 'list'] as const,
  list: (nodeId: number, viewType?: string) =>
    [...nodeViewKeys.lists(), nodeId, viewType] as const,
  byType: (nodeId: number) => [...nodeViewKeys.all, 'byType', nodeId] as const,
  details: () => [...nodeViewKeys.all, 'detail'] as const,
  detail: (viewId: number) => [...nodeViewKeys.details(), viewId] as const,
  default: (nodeId: number, viewType: string) =>
    [...nodeViewKeys.all, 'default', nodeId, viewType] as const,
  queryResults: () => [...nodeViewKeys.all, 'queryResults'] as const,
  queryResult: (viewId: number, params?: Record<string, unknown>) =>
    [...nodeViewKeys.queryResults(), viewId, params] as const,
  count: (viewId?: number | null, request?: unknown) =>
    [...nodeViewKeys.queryResults(), 'count', viewId ?? 'all', request ?? {}] as const,
  aggregate: (viewId: number | null | undefined, aggregation: unknown, nodeUuid?: string) =>
    ['node-view-aggregate', viewId, aggregation, nodeUuid ?? ''] as const,
};

// ==================== Property Query Keys ====================

export const propertyKeys = {
  all: ['properties'] as const,
  lists: () => [...propertyKeys.all, 'list'] as const,
  list: (type?: string) => [...propertyKeys.lists(), { type }] as const,
  detail: (id: number) => [...propertyKeys.all, 'detail', id] as const,
  forTag: (tagId: number) => [...propertyKeys.all, 'tag', tagId] as const,
  forClass: (classId: number) => [...propertyKeys.all, 'class', classId] as const,
  forClassInherited: (classId: number) => [...propertyKeys.all, 'class-inherited', classId] as const,
  classExtends: (classId: number) => [...propertyKeys.all, 'class-extends', classId] as const,
  inheritedProperties: (classId: number) => [...propertyKeys.all, 'inherited', classId] as const,
  extendedByClasses: (classId: number) => [...propertyKeys.all, 'extended-by', classId] as const,
  available: (opts: { contextNodeId?: number; contextClassIds?: number[] }) =>
    [...propertyKeys.all, 'available', opts] as const,
  nodes: (propertyId: number) => ['property-nodes', propertyId] as const,
  allNodes: () => ['property-nodes'] as const,
  suggestions: (contextNodeId?: number) => ['property-suggestions', contextNodeId] as const,
};

// ==================== Comment Query Keys ====================

export const commentKeys = {
  all: ['comments'] as const,
  forNode: (nodeId: number) => [...commentKeys.all, 'node', nodeId] as const,
  count: (nodeId: number) => [...commentKeys.all, 'count', nodeId] as const,
};

// ==================== Activity Query Keys ====================

export const activityKeys = {
  all: ['activity'] as const,
  forNode: (nodeId: number) => [...activityKeys.all, 'node', nodeId] as const,
  linkClicks: (sourceNodeId: number) => [...activityKeys.all, 'link-clicks', sourceNodeId] as const,
  linkClick: (sourceNodeId: number, targetNodeId: number) => [...activityKeys.all, 'link-click', sourceNodeId, targetNodeId] as const,
};

// ==================== Settings Query Keys ====================

export const settingsKeys = {
  all: ['settings'] as const,
};

// ==================== Workspace Settings Query Keys ====================

export const workspaceSettingsKeys = {
  all: ['workspace-settings'] as const,
};

// ==================== Favorites Query Keys ====================

export const favoriteKeys = {
  all: ['favorites'] as const,
  list: () => [...favoriteKeys.all, 'list'] as const,
};

// ==================== Recents Query Keys ====================

export const recentKeys = {
  all: ['recents'] as const,
  list: (limit?: number) => [...recentKeys.all, 'list', limit ?? 10] as const,
};

// ==================== Task Recurrence Query Keys ====================

export const taskKeys = {
  all: ['tasks'] as const,
  recurrence: (nodeId: number) => [...taskKeys.all, 'recurrence', nodeId] as const,
  completions: (nodeId: number, limit?: number, offset?: number) =>
    [...taskKeys.all, 'completions', nodeId, { limit: limit ?? 50, offset: offset ?? 0 }] as const,
  view: (activeTab?: string) => ['tasks-view', activeTab] as const,
};

// ==================== Trash Query Keys ====================

export const trashKeys = {
  all: ['trash'] as const,
  list: () => [...trashKeys.all, 'list'] as const,
};

// ==================== Archived Pages Query Keys ====================

export const archivedPagesKeys = {
  all: ['archived-pages'] as const,
  list: () => [...archivedPagesKeys.all, 'list'] as const,
};

// ==================== Workspace Query Keys ====================

export const workspaceKeys = {
  all: ['workspaces'] as const,
  list: () => [...workspaceKeys.all, 'list'] as const,
  exportJob: (jobId: string | number | null | undefined) => ['export-job', jobId] as const,
  nameCheck: (name: string) => ['workspace-name-check', name] as const,
};

// ==================== Auth Query Keys ====================

export const authKeys = {
  status: () => ['auth', 'status'] as const,
};

// ==================== Admin Query Keys ====================

export const adminKeys = {
  users: () => ['admin', 'users'] as const,
  metrics: () => ['admin', 'metrics'] as const,
};

// ==================== Search Query Keys ====================

export const searchKeys = {
  nodeSearchBox: (query: string) => ['node-search-box-custom', query] as const,
};

// ==================== Ad-hoc Query Keys ====================

export const queryKeys = {
  pseudoNodeQuery: (viewType: string, nodeId: number, viewMode: string) =>
    ['pseudo-node-query', viewType, nodeId, viewMode] as const,
  inlineQuery: (nodeId: number, ast: unknown, viewMode: string) =>
    ['inline-query', nodeId, ast, viewMode] as const,
  previewQuery: (nodeId: number, ast: unknown, viewMode: string) =>
    ['preview-query', nodeId, ast, viewMode] as const,
};
