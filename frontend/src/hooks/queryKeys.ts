/**
 * Query Keys for React Query
 * 
 * Centralized key factories for all node and property queries.
 * Use these consistently for cache invalidation and query matching.
 */

// Fast string hash for large ID arrays (avoids spreading 4000+ IDs into query keys)
function hashStringArray(ids: string[]): string {
  let hash = ids.length;
  for (let i = 0; i < ids.length; i++) {
    for (let j = 0; j < ids[i].length; j++) {
      hash = ((hash << 5) - hash + ids[i].charCodeAt(j)) | 0;
    }
  }
  return String(hash);
}

// ==================== Node Query Keys ====================

export const nodeKeys = {
  all: ['nodes'] as const,
  lists: () => [...nodeKeys.all, 'list'] as const,
  list: (filters: { pages_only?: boolean; parent_uuid?: string; tag_uuid?: string }) =>
    [...nodeKeys.lists(), filters] as const,
  details: () => [...nodeKeys.all, 'detail'] as const,
  detail: (id: string, options?: { include_children?: boolean; include_backlinks?: boolean; include_properties?: boolean }) =>
    [...nodeKeys.details(), id, options ?? {}] as const,
  // Use this for cache invalidation - matches all detail queries for a node regardless of options
  detailBase: (id: string) => [...nodeKeys.details(), id] as const,
  byUuid: (uuid: string) => [...nodeKeys.all, 'uuid', uuid] as const,
  pageContent: (id: string) => [...nodeKeys.all, 'page-content', id] as const,
  backlinks: (id: string) => [...nodeKeys.all, 'backlinks', id] as const,
  allBacklinks: () => [...nodeKeys.all, 'backlinks'] as const,
  linkedRefs: (id: string, params?: { limit?: number; offset?: number }) =>
    [...nodeKeys.all, 'linked-refs', id, params ?? {}] as const,
  allLinkedRefs: () => [...nodeKeys.all, 'linked-refs'] as const,
  mentions: (id: string) => [...nodeKeys.all, 'mentions', id] as const,
  allMentions: () => [...nodeKeys.all, 'mentions'] as const,
  propertyBacklinks: (id: string) => [...nodeKeys.all, 'property-backlinks', id] as const,
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
  graphLinks: (nodeIds: string[], scope?: string, cooccurrence?: boolean, contextNodeUuid?: string | null) => [...nodeKeys.all, 'graph-links', scope ?? 'between', cooccurrence ?? false, contextNodeUuid ?? 'none', nodeIds.length, hashStringArray(nodeIds)] as const,
  
  // PERFORMANCE: Metadata-only keys for lightweight queries
  // These are separate from detail queries to avoid cache pollution
  metadata: (id: string) => [...nodeKeys.all, 'metadata', id] as const,
  childrenOnly: (id: string) => [...nodeKeys.all, 'children-only', id] as const,
  breadcrumbs: (id: string) => [...nodeKeys.all, 'breadcrumbs', id] as const,
  breadcrumbsByUuid: (uuid: string) => [...nodeKeys.all, 'breadcrumbs', 'uuid', uuid] as const,
  batchGet: (ids: string[]) => [...nodeKeys.all, 'batch-get', ...ids.slice().sort()] as const,
  batchProperties: (ids: string[]) => [...nodeKeys.all, 'batch-properties', ...ids.slice().sort()] as const,
  suggestions: (classFilters?: string) => [...nodeKeys.all, 'suggestions', classFilters ?? ''] as const,
  aliases: (id: string) => [...nodeKeys.all, 'aliases', id] as const,
  // Prefix keys for cache-wide invalidation (match all regardless of ID)
  archived: () => [...nodeKeys.all, 'archived'] as const,
  byClass: (classId: string) => [...nodeKeys.all, 'by-class', classId] as const,
  byTag: (tagId: string) => [...nodeKeys.all, 'by-tag', tagId] as const,
  textLinks: (nodeUuid: string) => ['textLinks', nodeUuid] as const,
  inlineClasses: (nodeUuid: string) => ['inlineClasses', nodeUuid] as const,
  pageContents: () => [...nodeKeys.all, 'page-content'] as const,
  uuids: () => [...nodeKeys.all, 'uuid'] as const,
  pseudoNodeQuery: () => ['pseudo-node-query'] as const,
  inlineQuery: () => ['inline-query'] as const,
  uuidBatch: (nodeUuids: string[]) => [...nodeKeys.all, 'uuid-batch', hashStringArray(nodeUuids)] as const,
  ganttDayNodes: (ids: string[]) => [...nodeKeys.all, 'gantt-day-nodes', hashStringArray(ids)] as const,
};

// ==================== NodeView Query Keys ====================

export const nodeViewKeys = {
  all: ['nodeViews'] as const,
  lists: () => [...nodeViewKeys.all, 'list'] as const,
  list: (nodeUuid: string, viewType?: string) =>
    [...nodeViewKeys.lists(), nodeUuid, viewType] as const,
  byType: (nodeUuid: string) => [...nodeViewKeys.all, 'byType', nodeUuid] as const,
  details: () => [...nodeViewKeys.all, 'detail'] as const,
  detail: (viewId: string) => [...nodeViewKeys.details(), viewId] as const,
  default: (nodeUuid: string, viewType: string) =>
    [...nodeViewKeys.all, 'default', nodeUuid, viewType] as const,
  queryResults: () => [...nodeViewKeys.all, 'queryResults'] as const,
  queryResult: (viewId: string, params?: Record<string, unknown>) =>
    [...nodeViewKeys.queryResults(), viewId, params] as const,
  count: (viewId?: string | null, request?: unknown) =>
    [...nodeViewKeys.queryResults(), 'count', viewId ?? 'all', request ?? {}] as const,
  aggregate: (viewId: string | null | undefined, aggregation: unknown, nodeUuid?: string) =>
    ['node-view-aggregate', viewId, aggregation, nodeUuid ?? ''] as const,
};

// ==================== Property Query Keys ====================

export const propertyKeys = {
  all: ['properties'] as const,
  lists: () => [...propertyKeys.all, 'list'] as const,
  list: (type?: string) => [...propertyKeys.lists(), { type }] as const,
  detail: (id: string) => [...propertyKeys.all, 'detail', id] as const,
  forTag: (tagId: string) => [...propertyKeys.all, 'tag', tagId] as const,
  forClass: (classId: string) => [...propertyKeys.all, 'class', classId] as const,
  forClassInherited: (classId: string) => [...propertyKeys.all, 'class-inherited', classId] as const,
  classExtends: (classId: string) => [...propertyKeys.all, 'class-extends', classId] as const,
  inheritedProperties: (classId: string) => [...propertyKeys.all, 'inherited', classId] as const,
  extendedByClasses: (classId: string) => [...propertyKeys.all, 'extended-by', classId] as const,
  available: (opts: { contextNodeUuid?: string; contextClassUuids?: string[] }) =>
    [...propertyKeys.all, 'available', opts] as const,
  nodes: (propertyUuid: string) => ['property-nodes', propertyUuid] as const,
  allNodes: () => ['property-nodes'] as const,
  suggestions: (contextNodeUuid?: string) => ['property-suggestions', contextNodeUuid] as const,
};

// ==================== Comment Query Keys ====================

export const commentKeys = {
  all: ['comments'] as const,
  forNode: (nodeUuid: string) => [...commentKeys.all, 'node', nodeUuid] as const,
  count: (nodeUuid: string) => [...commentKeys.all, 'count', nodeUuid] as const,
};

// ==================== Activity Query Keys ====================

export const activityKeys = {
  all: ['activity'] as const,
  forNode: (nodeUuid: string) => [...activityKeys.all, 'node', nodeUuid] as const,
  linkClicks: (sourceNodeUuid: string) => [...activityKeys.all, 'link-clicks', sourceNodeUuid] as const,
  linkClick: (sourceNodeUuid: string, targetNodeUuid: string) => [...activityKeys.all, 'link-click', sourceNodeUuid, targetNodeUuid] as const,
};

// ==================== Settings Query Keys ====================

export const settingsKeys = {
  all: ['settings'] as const,
};

// ==================== Workspace Settings Query Keys ====================

export const workspaceSettingsKeys = {
  all: ['workspace-settings'] as const,
  detail: (workspaceUuid: string) => [...workspaceSettingsKeys.all, workspaceUuid] as const,
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
  recurrence: (nodeUuid: string) => [...taskKeys.all, 'recurrence', nodeUuid] as const,
  completions: (nodeUuid: string, limit?: number, offset?: number) =>
    [...taskKeys.all, 'completions', nodeUuid, { limit: limit ?? 50, offset: offset ?? 0 }] as const,
  popup: (section: string) => [...taskKeys.all, 'popup', section] as const,
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
  exportJob: (jobUuid: string | null | undefined) => ['export-job', jobUuid] as const,
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
  pseudoNodeQuery: (viewType: string, nodeUuid: string, viewMode: string) =>
    ['pseudo-node-query', viewType, nodeUuid, viewMode] as const,
  inlineQuery: (nodeUuid: string, ast: unknown, viewMode: string) =>
    ['inline-query', nodeUuid, ast, viewMode] as const,
  previewQuery: (nodeUuid: string, ast: unknown, viewMode: string) =>
    ['preview-query', nodeUuid, ast, viewMode] as const,
};

// ==================== Shares Query Keys ====================

export const sharesKeys = {
  all: ['shares'] as const,
  node: (nodeUuid: string) => [...sharesKeys.all, 'node', nodeUuid] as const,
  workspace: () => [...sharesKeys.all, 'workspace'] as const,
  public: (shareUuid: string) => ['public-share', shareUuid] as const,
  userShares: (nodeUuid: string) => [...sharesKeys.all, 'user-shares', nodeUuid] as const,
  inbox: () => [...sharesKeys.all, 'inbox'] as const,
  workspaceMembers: (workspaceUuid: string) => ['workspace-members', workspaceUuid] as const,
};

// ==================== Templates Query Keys ====================

export const templateKeys = {
  all: ['templates'] as const,
  list: () => [...templateKeys.all, 'list'] as const,
  variables: (nodeUuid: string) => [...templateKeys.all, 'variables', nodeUuid] as const,
};

// ==================== Plugin Query Keys ====================

export const pluginKeys = {
  all: ['plugins'] as const,
  list: () => [...pluginKeys.all, 'list'] as const,
  installJob: (jobId: string | null | undefined) => [...pluginKeys.all, 'install-job', jobId] as const,
  importers: () => [...pluginKeys.all, 'importers'] as const,
  exporters: () => [...pluginKeys.all, 'exporters'] as const,
};

export const pluginSettingsKeys = {
  all: ['plugin-settings'] as const,
  forPlugin: (pluginId: string) => [...pluginSettingsKeys.all, pluginId] as const,
};

// ==================== Notifications Query Keys ====================

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (includeRead: boolean) => [...notificationKeys.all, 'list', includeRead] as const,
};
