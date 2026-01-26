/**
 * Query Keys for React Query
 * 
 * Centralized key factories for all node and property queries.
 * Use these consistently for cache invalidation and query matching.
 */

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
  linkedRefs: (id: number) => [...nodeKeys.all, 'linked-refs', id] as const,
  propertyBacklinks: (id: number) => [...nodeKeys.all, 'property-backlinks', id] as const,
  daily: (date: string) => [...nodeKeys.all, 'daily', date] as const,
  monthly: (year: number, month: number) => [...nodeKeys.all, 'monthly', year, month] as const,
  yearly: (year: number) => [...nodeKeys.all, 'yearly', year] as const,
  search: (query: string) => [...nodeKeys.all, 'search', query] as const,
  pages: (options?: { includeChildren?: boolean; rootOnly?: boolean }) => 
    [...nodeKeys.all, 'pages', options ?? {}] as const,
  tags: () => [...nodeKeys.all, 'tags'] as const,
  classes: () => [...nodeKeys.all, 'classes'] as const,
  tasks: (includeComplete?: boolean) => [...nodeKeys.all, 'tasks', { includeComplete }] as const,
  graph: () => [...nodeKeys.all, 'graph'] as const,
  
  // PERFORMANCE: Metadata-only keys for lightweight queries
  // These are separate from detail queries to avoid cache pollution
  metadata: (id: number) => [...nodeKeys.all, 'metadata', id] as const,
  childrenOnly: (id: number) => [...nodeKeys.all, 'children-only', id] as const,
  breadcrumbs: (id: number) => [...nodeKeys.all, 'breadcrumbs', id] as const,
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
