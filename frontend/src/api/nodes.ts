/**
 * Nodes API functions
 */
import api from '@/api/client';
import { nodeQueryWorkerClient } from '@/lib/nodeQueryWorkerClient';
import type {
  Node,
  NodeCreate,
  NodeUpdate,
  NodesResponse,
  PaginatedResponse,
  Backlink,
  BacklinksResponse,
  LinkedReference,
  LinkedReferencesResponse,
  Mention,
  MentionsResponse,
  BatchNodeCreateRequest,
  BatchNodeCreateResponse,
  BatchNodeUpdateRequest,
  BatchNodeUpdateResponse,
  BatchNodeDeleteRequest,
  BatchNodeDeleteResponse,
  BatchPermanentDeleteRequest,
  BatchPermanentDeleteResponse,
  BatchGetNodesRequest,
  BatchGetNodesResponse,
  BatchGetNodesByUuidRequest,
  BatchGetNodesByUuidResponse,
  BatchNodeDailyResponse,
  BreadcrumbsResponse,
} from '@/types/api';

const BASE = '/nodes';

/**
 * List nodes with optional filters
 * 
 * @param params.pages_only - Only return pages (no blocks)
 * @param params.parent_id - Only return children of this node
 * @param params.tag_id - Only return nodes with this tag
 * @param params.type_filters - Comma-separated type IDs to filter by
 * @param params.include_children - Include nested children for each node
 * @param params.root_only - Only return root nodes (no parent)
 */
export async function listNodes(params?: {
  pages_only?: boolean;
  parent_id?: number;
  tag_id?: number;
  type_filters?: string;
  class_filters?: string;
  include_children?: boolean;
  root_only?: boolean;
  page?: number;
  page_size?: number;
}): Promise<Node[]> {
  // Use trailing slash to match FastAPI route
  // Backend returns PaginatedResponse with 'items' field, not 'nodes'
  const response = await api.get<{ items: Node[] }>(`${BASE}/`, { params });
  return response.data.items ?? [];
}

/**
 * Get a node by ID
 */
export async function getNode(
  id: number,
  options?: {
    include_children?: boolean;
    include_backlinks?: boolean;
    include_properties?: boolean;
  }
): Promise<Node> {
  const response = await api.get<Node>(`${BASE}/${id}`, { params: options });
  return response.data;
}

/**
 * Get a node by UUID
 */
export async function getNodeByUuid(
  uuid: string,
  options?: {
    include_children?: boolean;
    include_backlinks?: boolean;
  }
): Promise<Node> {
  const response = await api.get<Node>(`${BASE}/uuid/${uuid}`, { params: options });
  return response.data;
}

/**
 * Get page content with blocks, properties, and backlinks
 */
export async function getPageContent(pageId: number): Promise<Node> {
  const response = await api.get<Node>(`${BASE}/page/${pageId}/content`);
  return response.data;
}

/**
 * Fetch multiple nodes by ID in a single call.
 * Returns a map of node_id (string) -> Node for all found nodes.
 * Missing or inaccessible IDs are silently omitted.
 */
export async function batchGetNodes(request: BatchGetNodesRequest): Promise<BatchGetNodesResponse> {
  const response = await api.post<BatchGetNodesResponse>(`${BASE}/batch-get`, request);
  return response.data;
}

/**
 * Fetch multiple nodes by UUID in a single call.
 * Returns a map of node_uuid (string) -> Node for all found nodes.
 * Missing or inaccessible UUIDs are silently omitted.
 */
export async function batchGetNodesByUuid(request: BatchGetNodesByUuidRequest): Promise<BatchGetNodesByUuidResponse> {
  const response = await api.post<BatchGetNodesByUuidResponse>(`${BASE}/batch-get-by-uuid`, request);
  return response.data;
}

/**
 * Get the ancestor breadcrumb chain for a node.
 * Returns ordered list from root ancestor to immediate parent.
 * Uses closure table for O(1) lookup — much faster than chaining GET requests.
 */
export async function getBreadcrumbs(nodeId: number): Promise<BreadcrumbsResponse> {
  const response = await api.get<BreadcrumbsResponse>(`${BASE}/${nodeId}/breadcrumbs`);
  return response.data;
}

/**
 * Create a new node
 */
export async function createNode(data: NodeCreate): Promise<Node> {
  // Use trailing slash to match FastAPI route
  const response = await api.post<Node>(`${BASE}/`, data);
  return response.data;
}

/**
 * Create a new page (convenience)
 */
export async function createPage(
  name: string,
  icon?: string | null,
  color?: string | null,
  additionalTags?: number[]
): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/page`, null, {
    params: { name, icon, color, additional_tags: additionalTags },
  });
  return response.data;
}

/**
 * List all existing daily pages
 */
export async function listDailyPages(
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<Node>> {
  const response = await api.get<PaginatedResponse<Node>>(`${BASE}/daily/list`, {
    params: { page, page_size },
  });
  return response.data;
}

/**
 * @deprecated Use listDailyPages instead. Kept as alias for backward compatibility.
 */
export const getDailyPages = listDailyPages;

/**
 * Get or create a daily note
 */
export async function getOrCreateDaily(dateStr: string): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/daily`, null, {
    params: { date: dateStr },
  });
  return response.data;
}

/**
 * Get or create multiple daily notes in a single batch request.
 */
export async function batchGetOrCreateDaily(dates: string[]): Promise<BatchNodeDailyResponse> {
  const response = await api.post<BatchNodeDailyResponse>(`${BASE}/daily/batch`, { dates });
  return response.data;
}

/**
 * Get or create a monthly note
 */
export async function getOrCreateMonthly(year: number, month: number): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/monthly`, null, {
    params: { year, month },
  });
  return response.data;
}

/**
 * Get or create a yearly note
 */
export async function getOrCreateYearly(year: number): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/yearly`, null, {
    params: { year },
  });
  return response.data;
}

/**
 * Update a node
 */
export async function updateNode(id: number, data: NodeUpdate): Promise<Node> {
  const response = await api.put<Node>(`${BASE}/${id}`, data);
  return response.data;
}

/**
 * Create multiple nodes in a single batch.
 * Each node is processed independently — failures don't block others.
 * Useful for Logseq / bulk imports.
 */
export async function batchCreateNodes(
  request: BatchNodeCreateRequest,
  options?: { headers?: Record<string, string> },
): Promise<BatchNodeCreateResponse> {
  const response = await api.post<BatchNodeCreateResponse>(`${BASE}/batch`, request, {
    headers: options?.headers,
  });
  return response.data;
}

/**
 * Update multiple nodes in a single batch.
 * Nodes can be identified by id or uuid.
 * Useful for Logseq / bulk imports where many blocks need content updates.
 */
export async function batchUpdateNodes(request: BatchNodeUpdateRequest): Promise<BatchNodeUpdateResponse> {
  const response = await api.put<BatchNodeUpdateResponse>(`${BASE}/batch`, request);
  return response.data;
}

/**
 * Delete multiple nodes by UUID in a single batch.
 * Each node is processed independently — failures don't block others.
 */
export async function batchDeleteNodes(request: BatchNodeDeleteRequest): Promise<BatchNodeDeleteResponse> {
  const response = await api.delete<BatchNodeDeleteResponse>(`${BASE}/batch`, { data: request });
  return response.data;
}

/**
 * Delete a node
 */
export async function deleteNode(id: number): Promise<void> {
  await api.delete(`${BASE}/${id}`);
}

/**
 * Archive a node (set active to false)
 */
export async function archiveNode(id: number): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/${id}/archive`);
  return response.data;
}

/**
 * Unarchive a node (set active to true)
 */
export async function unarchiveNode(id: number): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/${id}/unarchive`);
  return response.data;
}

/**
 * Merge source page into target page.
 * Moves all blocks from source to target, redirects backlinks, then deletes source.
 */
export async function mergePages(
  sourceId: number,
  targetId: number,
): Promise<{ children_moved: number; target_id: number }> {
  const response = await api.post<{ children_moved: number; target_id: number }>(
    `${BASE}/${sourceId}/merge-into/${targetId}`,
  );
  return response.data;
}

/**
 * Get all archived pages
 */
export async function getArchivedPages(
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<Node>> {
  const response = await api.get<PaginatedResponse<Node>>(`${BASE}/archived`, {
    params: { page, page_size },
  });
  return response.data;
}

/**
 * Get all nodes with a specific class
 */
export async function getNodesWithClass(
  classId: number,
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<Node>> {
  const response = await api.get<PaginatedResponse<Node>>(`${BASE}/classes/${classId}/nodes`, {
    params: { page, page_size },
  });
  return response.data;
}

/**
 * Set a property value on a node
 */
export async function setProperty(
  nodeId: number,
  propertyId: number,
  value: unknown
): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/${nodeId}/properties`, {
    property_id: propertyId,
    value,
  });
  return response.data;
}

/**
 * Remove a property value from a node
 */
export async function removeProperty(
  nodeId: number,
  propertyId: number
): Promise<Node> {
  const response = await api.delete<Node>(
    `${BASE}/${nodeId}/properties/${propertyId}`
  );
  return response.data;
}

/**
 * Batch-fetch property values for multiple nodes in a single request.
 * Returns { nodeId -> { propertyId -> value } }.
 */
export type BatchPropertiesResult = Record<string, Record<string, unknown>>;

export async function batchGetPropertyValues(
  nodeIds: number[]
): Promise<BatchPropertiesResult> {
  const response = await api.post<BatchPropertiesResult>(
    `${BASE}/batch/properties`,
    { node_ids: nodeIds }
  );
  return response.data;
}

/**
 * Get backlinks to a node
 */
export async function getBacklinks(
  nodeId: number,
  includeInherited = true
): Promise<Backlink[]> {
  const data = await nodeQueryWorkerClient.get<BacklinksResponse>(
    `/api/nodes/${nodeId}/backlinks?include_inherited=${includeInherited}`,
  );
  return data.backlinks ?? [];
}

/**
 * Get linked references to a node with context
 */
export async function getLinkedReferences(
  nodeId: number,
  params?: { limit?: number; offset?: number }
): Promise<{ linked_references: LinkedReference[]; total_count: number }> {
  const query = new URLSearchParams();
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  if (params?.offset !== undefined) query.set('offset', String(params.offset));
  const qs = query.toString();
  const data = await nodeQueryWorkerClient.get<LinkedReferencesResponse>(
    `/api/nodes/${nodeId}/linked-references${qs ? '?' + qs : ''}`,
  );
  return { linked_references: data.linked_references ?? [], total_count: data.total_count ?? 0 };
}

/**
 * Move a node to a new parent and/or position
 */
export async function moveNode(
  id: number,
  parentId: number | null,
  position?: number
): Promise<Node> {
  const response = await api.put<Node>(`${BASE}/${id}/move`, {
    parent_id: parentId,
    position,
  });
  return response.data;
}

/**
 * Convert a block into a root page.
 */
export async function convertToPage(id: number, name?: string): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/${id}/convert-to-page`, { name });
  return response.data;
}

/**
 * Convert a page into a block under a destination page.
 */
export async function convertToBlock(
  id: number,
  parentId: number,
  position?: number
): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/${id}/convert-to-block`, {
    parent_id: parentId,
    position,
  });
  return response.data;
}

/**
 * Search nodes by name
 * 
 * @param query - Search query string
 * @param options - Optional search filters
 */
export async function searchNodes(query: string, options?: {
  class_filters?: string;
  uuid?: string;
  is_page?: boolean;
  is_class?: boolean;
  is_daily?: boolean;
  is_user_page?: boolean;
}): Promise<Node[]> {
  const params: Record<string, string | boolean> = { q: query };
  if (options?.class_filters) params.class_filters = options.class_filters;
  if (options?.uuid) params.uuid = options.uuid;
  if (options?.is_page !== undefined) params.is_page = options.is_page;
  if (options?.is_class !== undefined) params.is_class = options.is_class;
  if (options?.is_daily !== undefined) params.is_daily = options.is_daily;
  if (options?.is_user_page !== undefined) params.is_user_page = options.is_user_page;
  const response = await api.get<NodesResponse>(`${BASE}/search`, { params });
  return response.data.nodes ?? [];
}

/**
 * List all classes (nodes that can categorize other nodes)
 */
export async function listClasses(): Promise<Node[]> {
  const response = await api.get<NodesResponse>(`${BASE}/classes`);
  return response.data.nodes ?? [];
}

/**
 * Search for classes by name
 */
export async function searchClasses(query: string): Promise<Node[]> {
  const response = await api.get<NodesResponse>(`${BASE}/classes/search`, {
    params: { q: query },
  });
  return response.data.nodes ?? [];
}

/**
 * Add a class to a node (sets the "classes" property)
 */
export async function addClass(nodeId: number, classNodeId: number): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/${nodeId}/classes`, {
    class_node_id: classNodeId,
  });
  return response.data;
}

/**
 * Remove a class from a node
 */
export async function removeClass(nodeId: number, classNodeId: number): Promise<Node> {
  const response = await api.delete<Node>(`${BASE}/${nodeId}/classes/${classNodeId}`);
  return response.data;
}

/**
 * List tasks
 */
export async function listTasks(
  includeComplete = false,
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<Node>> {
  const response = await api.get<PaginatedResponse<Node>>(`${BASE}/tasks`, {
    params: { include_complete: includeComplete, page, page_size },
  });
  return response.data;
}

// ==================== Graph ====================

/**
 * Graph node for visualization
 */
export interface GraphNode {
  id: number;
  uuid: string;
  name: string;
  type?: 'page' | 'block';
  tags?: string[];
  class_ids?: number[];
  properties?: Record<string, unknown>;
  is_daily?: boolean;
  is_class?: boolean;
  is_monthly?: boolean;
  is_yearly?: boolean;
  icon?: string;
  created_at?: string;
  backlink_count?: number;
  internal_link_count?: number;
  block_count?: number;
  aliased_id?: number | null;
}

/**
 * Graph link for visualization
 */
export interface GraphLink {
  source: number;
  target: number;
  type: 'parent' | 'reference' | 'class' | 'extends' | 'property-reference' | 'cooccurrence';
  weight?: number;
}

/**
 * Graph data response
 * @deprecated Use getGraphNodes + getLinksForNodes separately instead
 */
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  total?: number;
  page?: number;
  page_size?: number;
  has_next?: boolean;
  has_prev?: boolean;
}

/**
 * Get workspace data for visualization
 * @deprecated Use getGraphNodes + getLinksForNodes separately instead
 */
export async function getWorkspaceData(
  page?: number,
  page_size?: number,
): Promise<GraphData> {
  const response = await api.get<GraphData>(`${BASE}/workspace`, {
    params: { page, page_size },
  });
  return response.data;
}

/**
 * Get workspace nodes for visualization (without links).
 * Lighter than getWorkspaceData — use when links are fetched separately.
 */
export async function getGraphNodes(
  page: number = 1,
  page_size?: number,
): Promise<PaginatedResponse<GraphNode>> {
  const params: Record<string, number> = { page };
  if (page_size !== undefined) {
    params.page_size = page_size;
  }
  const response = await api.get<PaginatedResponse<GraphNode>>(`${BASE}/workspace/nodes`, {
    params,
  });
  return response.data;
}

/**
 * Get links between a specific set of node IDs
 * Returns all link types (reference, parent, class, extends, property-reference).
 * 
 * @param scope - "between" (default): both ends in set. "touching": at least one end in set.
 */
export async function getLinksForNodes(
  nodeIds: number[],
  scope: 'between' | 'touching' = 'between',
  cooccurrence = false,
  contextNodeId?: number | null,
): Promise<GraphLink[]> {
  if (nodeIds.length === 0) return [];
  const body: Record<string, unknown> = {
    node_ids: nodeIds,
    scope,
    cooccurrence,
  };
  if (contextNodeId != null) {
    body.context_node_id = contextNodeId;
  }
  const response = await api.post<{ links: GraphLink[] }>(`${BASE}/links`, body);
  return response.data.links;
}

/**
 * Update date format response
 */
export interface UpdateDateFormatResponse {
  status: string;
  updated_count: number;
  errors: string[];
}

/**
 * Update date format for all date/month nodes
 */
export async function updateDateFormat(newFormat: string): Promise<UpdateDateFormatResponse> {
  const response = await api.post<UpdateDateFormatResponse>(`${BASE}/settings/update-date-format`, {
    new_format: newFormat,
  });
  return response.data;
}

/**
 * Property backlink (pages referencing via date/node properties)
 */
export interface PropertyBacklink {
  source_page: Node;
  property_id: number;
  property_name: string;
}

/**
 * Get property backlinks (pages that reference via date or node properties)
 */
export async function getPropertyBacklinks(nodeId: number): Promise<PropertyBacklink[]> {
  const data = await nodeQueryWorkerClient.get<{ property_backlinks: PropertyBacklink[] }>(
    `/api/nodes/${nodeId}/property-backlinks`,
  );
  return data.property_backlinks ?? [];
}

// ==================== Comments ====================

/**
 * Response with list of comments (comments are full Node objects)
 */
export interface CommentsResponse {
  comments: Node[];
  comment_count: number;
}

/**
 * Get all comments for a node
 */
export async function getComments(
  nodeId: number,
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<Node>> {
  const response = await api.get<PaginatedResponse<Node>>(`${BASE}/${nodeId}/comments`, {
    params: { page, page_size },
  });
  return response.data;
}

/**
 * Create a new comment on a node
 */
export async function createComment(nodeId: number, name: string, parentCommentId?: number): Promise<Node> {
  const body: Record<string, unknown> = { name };
  if (parentCommentId) body.parent_comment_id = parentCommentId;
  const response = await api.post<Node>(`${BASE}/${nodeId}/comments`, body);
  return response.data;
}

/**
 * Delete a comment from a node
 */
export async function deleteComment(nodeId: number, commentId: number): Promise<void> {
  await api.delete(`${BASE}/${nodeId}/comments/${commentId}`);
}

/**
 * Get the count of comments for a node (useful for showing indicators)
 */
export async function getCommentCount(nodeId: number): Promise<number> {
  const response = await api.get<{ count: number }>(`${BASE}/${nodeId}/comment-count`);
  return response.data.count;
}

/**
 * Text link info
 */
export interface TextLink {
  id: number;
  uuid: string;
  source_node_id: number;
  target_node_id: number;
  position: number;
  name?: string | null;
}

/**
 * Get all text links from a node
 */
export async function getTextLinks(nodeId: number): Promise<TextLink[]> {
  const response = await api.get<{ links: TextLink[] }>(`${BASE}/${nodeId}/text-links`);
  return response.data.links ?? [];
}

/**
 * Get text links for multiple nodes in a single request.
 * Returns a map of node ID to its text links.
 */
export async function batchGetTextLinks(nodeIds: number[]): Promise<Record<string, TextLink[]>> {
  if (nodeIds.length === 0) return {};
  const response = await api.post<{ links_by_node: Record<string, TextLink[]> }>(`${BASE}/batch-text-links`, {
    node_ids: nodeIds,
  });
  return response.data.links_by_node ?? {};
}

/**
 * Add a tag to a node
 */
export async function addTagLink(nodeId: number, targetNodeId: number): Promise<{ success: boolean }> {
  const response = await api.post<{ success: boolean }>(`${BASE}/${nodeId}/tag-links`, {
    target_node_id: targetNodeId,
  });
  return response.data;
}

/**
 * Remove a tag from a node
 */
export async function removeTagLink(nodeId: number, targetId: number): Promise<{ removed: boolean }> {
  const response = await api.delete<{ removed: boolean }>(`${BASE}/${nodeId}/tag-links/${targetId}`);
  return response.data;
}

// ==================== Aliases ====================

/**
 * Get all aliases for a node
 */
export async function getAliases(nodeId: number): Promise<Node[]> {
  const response = await api.get<{ aliases: Node[] }>(`${BASE}/${nodeId}/aliases`);
  return response.data.aliases ?? [];
}

/**
 * Add a page as an alias of a node
 */
export async function addAlias(nodeId: number, aliasNodeId: number): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/${nodeId}/aliases`, {
    alias_node_id: aliasNodeId,
  });
  return response.data;
}

/**
 * Remove an alias from a node
 */
export async function removeAlias(nodeId: number, aliasId: number): Promise<void> {
  await api.delete(`${BASE}/${nodeId}/aliases/${aliasId}`);
}

// ============== Page View Tracking & Recents ==============

/**
 * Mark a page as opened/viewed (updates open_date)
 */
export async function markPageOpened(nodeId: number): Promise<{ status: string; open_date: string }> {
  const response = await api.patch<{ status: string; open_date: string }>(`${BASE}/${nodeId}/open`);
  return response.data;
}

/**
 * Recent page info
 */
export interface RecentPage {
  id: number;
  uuid: string;
  name: string;
  icon: string | null;
  color: string | null;
  parent_id: number | null;
  page_id: number | null;
  is_page: boolean;
  is_class: boolean;
  is_daily: boolean;
  is_monthly: boolean;
  is_yearly: boolean;
  create_date: string;
  write_date: string;
  open_date: string;
  classes?: number[];
  aliased_id?: number | null;
  aliases?: number[];
}

/**
 * Get recently opened pages, ordered by open_date DESC
 */
export async function getRecentPages(limit: number = 10): Promise<RecentPage[]> {
  const response = await api.get<{ nodes: RecentPage[] }>(`${BASE}/recents`, { params: { limit } });
  return response.data.nodes ?? [];
}

/**
 * Get random pages from the workspace
 */
export async function getRandomPages(limit: number = 5): Promise<RecentPage[]> {
  const response = await api.get<{ nodes: RecentPage[] }>(`${BASE}/random`, { params: { limit } });
  return response.data.nodes ?? [];
}

/**
 * Get recently created pages, ordered by create_date DESC
 */
export async function getRecentlyCreatedPages(limit: number = 5): Promise<RecentPage[]> {
  const response = await api.get<{ nodes: RecentPage[] }>(`${BASE}/recently-created`, { params: { limit } });
  return response.data.nodes ?? [];
}

/**
 * Get suggested pages for node pickers (empty-query state).
 * Returns recently created pages (last 15 min) then most recently linked pages.
 * 
 * @param limit - Maximum number of suggestions
 * @param class_filters - Optional comma-separated class IDs to filter results
 */
export async function getSuggestions(limit: number = 20, class_filters?: string): Promise<Node[]> {
  const response = await api.get<{ nodes: Node[] }>(`${BASE}/suggestions`, {
    params: { limit, class_filters },
  });
  return response.data.nodes ?? [];
}

// ============== Version History ==============

export interface NodeVersion {
  id: number;
  name: string | null;
  created_at: string;
  user: string | null;
}

/**
 * Get version history for a node
 */
export async function getNodeVersions(nodeId: number, limit: number = 50): Promise<NodeVersion[]> {
  const response = await api.get<{ versions: NodeVersion[] }>(`${BASE}/${nodeId}/versions`, { params: { limit } });
  return response.data.versions ?? [];
}

/**
 * Get a specific version of a node
 */
export async function getNodeVersion(nodeId: number, versionId: number): Promise<NodeVersion> {
  const response = await api.get<NodeVersion>(`${BASE}/${nodeId}/versions/${versionId}`);
  return response.data;
}

/**
 * Restore a node to a previous version
 */
export async function restoreNodeVersion(nodeId: number, versionId: number): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/${nodeId}/versions/${versionId}/restore`);
  return response.data;
}

// ============== Favorites (DB-backed) ==============

/**
 * Get the list of favorite page IDs
 */
export async function getFavorites(
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<Node>> {
  const response = await api.get<PaginatedResponse<Node>>(`${BASE}/favorites`, {
    params: { page, page_size },
  });
  return response.data;
}

/**
 * Set the entire list of favorite page IDs
 */
export async function setFavorites(favorites: number[]): Promise<number[]> {
  const response = await api.put<{ status: string; favorites: number[] }>(`${BASE}/favorites`, { favorites });
  return response.data.favorites ?? [];
}

/**
 * Add a page to favorites
 */
export async function addFavorite(nodeId: number): Promise<number[]> {
  const response = await api.post<{ status: string; favorites: number[] }>(`${BASE}/favorites/${nodeId}`);
  return response.data.favorites ?? [];
}

/**
 * Remove a page from favorites
 */
export async function removeFavorite(nodeId: number): Promise<number[]> {
  const response = await api.delete<{ status: string; favorites: number[] }>(`${BASE}/favorites/${nodeId}`);
  return response.data.favorites ?? [];
}

/**
 * Reorder favorites
 */
export async function reorderFavorites(fromIndex: number, toIndex: number): Promise<number[]> {
  const response = await api.put<{ status: string; favorites: number[] }>(`${BASE}/favorites/reorder`, {
    from_index: fromIndex,
    to_index: toIndex,
  });
  return response.data.favorites ?? [];
}

/**
 * Get all soft-deleted nodes (trash)
 */
export async function getTrash(
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<Node>> {
  const response = await api.get<PaginatedResponse<Node>>(`${BASE}/trash`, {
    params: { page, page_size },
  });
  return response.data;
}

/**
 * Restore a soft-deleted node
 */
export async function restoreNode(nodeId: number): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/${nodeId}/restore`);
  return response.data;
}

/**
 * Permanently delete a node (hard delete)
 */
export async function permanentlyDeleteNode(nodeId: number): Promise<void> {
  await api.delete(`${BASE}/${nodeId}/permanent`);
}

/**
 * Empty trash - permanently delete all soft-deleted nodes
 */
export async function emptyTrash(): Promise<{ deleted_count: number }> {
  const response = await api.post(`${BASE}/trash/empty`);
  return response.data;
}

/**
 * Clear all blocks from the Scratchpad system page.
 * Called on app startup to ensure scratchpad starts empty.
 */
export async function clearScratchpad(): Promise<{ status: string; deleted_count: number }> {
  const response = await api.post<{ status: string; deleted_count: number }>(`${BASE}/scratchpad/clear`);
  return response.data;
}

/**
 * Permanently delete multiple nodes from trash by ID.
 * Each node is processed independently — failures don't block others.
 */
export async function batchPermanentlyDeleteNodes(request: BatchPermanentDeleteRequest): Promise<BatchPermanentDeleteResponse> {
  const response = await api.post<BatchPermanentDeleteResponse>(`${BASE}/trash/batch-delete`, request);
  return response.data;
}

/**
 * Rebuild all node_link records from AST content.
 * 
 * This command:
 * 1. Deletes all existing text links and inline class links
 * 2. Re-parses all nodes' AST content to rebuild both types of links
 * 3. Returns statistics about the operation
 * 
 * Use this when link data may have become inconsistent.
 */
export interface RebuildLinksResponse {
  success: boolean;
  nodes_processed: number;
  links_created: number;
  inline_classes_created: number;
  errors: string[];
  total_errors: number;
}

export async function rebuildAllLinks(): Promise<RebuildLinksResponse> {
  const response = await api.post<RebuildLinksResponse>(`${BASE}/rebuild-links`);
  return response.data;
}

/**
 * Fix raw [[uuid]] text in AST content by converting to proper node_link nodes.
 * 
 * This command:
 * 1. Scans all nodes' AST content for text containing [[uuid]] patterns
 * 2. Resolves each UUID to an existing node
 * 3. Replaces the raw text with proper node_link AST objects
 * 4. Saves updated AST and rebuilds link records
 */
export interface FixRawUuidLinksResponse {
  success: boolean;
  nodes_processed: number;
  nodes_fixed: number;
  links_converted: number;
  errors: string[];
  total_errors: number;
}

export async function fixRawUuidLinks(): Promise<FixRawUuidLinksResponse> {
  const response = await api.post<FixRawUuidLinksResponse>(`${BASE}/fix-raw-uuid-links`);
  return response.data;
}

/** Fix all broken_link and raw [[uuid]] references pointing to a specific UUID. */
export interface FixLinksForUuidResponse {
  success: boolean;
  target_uuid: string;
  nodes_fixed: number;
  links_converted: number;
  errors: string[];
  total_errors: number;
}

export async function fixLinksForUuid(uuid: string): Promise<FixLinksForUuidResponse> {
  const response = await api.post<FixLinksForUuidResponse>(`${BASE}/fix-links-for-uuid/${encodeURIComponent(uuid)}`);
  return response.data;
}

// ==================== Templates ====================

export interface TemplateInstantiateOptions {
  parent_id?: number;
  name?: string;
  variables?: Record<string, string>;
  dynamic_context?: Record<string, string>;
  as_blocks?: boolean;
  after_id?: number;
}

export interface TemplateInstantiateResult {
  node: Node | null;
  blocks: Node[];
  as_blocks: boolean;
}

export async function listTemplates(
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<Node>> {
  const response = await api.get<PaginatedResponse<Node>>(`${BASE}/templates`, {
    params: { page, page_size },
  });
  return response.data;
}

export interface TemplateVariablesResult {
  variables: string[];
  dynamic_variables: string[];
}

export async function getTemplateVariables(nodeId: number): Promise<TemplateVariablesResult> {
  const response = await api.get<TemplateVariablesResult>(`${BASE}/${nodeId}/template-variables`);
  return response.data;
}

export async function instantiateTemplate(
  nodeId: number,
  options: TemplateInstantiateOptions,
): Promise<TemplateInstantiateResult> {
  const response = await api.post<TemplateInstantiateResult>(`${BASE}/${nodeId}/instantiate`, options);
  return response.data;
}

// ==================== Unlinked Mentions ====================

/**
 * Get unlinked mention candidates for a node.
 */
export async function getUnlinkedMentions(nodeId: number): Promise<Mention[]> {
  const response = await api.get<MentionsResponse>(`${BASE}/${nodeId}/mentions`);
  return response.data.mentions ?? [];
}

/**
 * Promote an unlinked mention into a real node link.
 */
export async function promoteMention(
  nodeId: number,
  mentionId: number,
): Promise<{ success: boolean; source_node_id: number | null }> {
  const response = await api.post<{ success: boolean; source_node_id: number | null }>(
    `${BASE}/${nodeId}/mentions/${mentionId}/promote`,
  );
  return response.data;
}

/**
 * Ignore an unlinked mention candidate.
 */
export async function ignoreMention(
  nodeId: number,
  mentionId: number,
): Promise<{ success: boolean; is_ignored: boolean }> {
  const response = await api.post<{ success: boolean; is_ignored: boolean }>(
    `${BASE}/${nodeId}/mentions/${mentionId}/ignore`,
  );
  return response.data;
}

/**
 * Restore a previously ignored mention candidate.
 */
export async function unignoreMention(
  nodeId: number,
  mentionId: number,
): Promise<{ success: boolean; is_ignored: boolean }> {
  const response = await api.post<{ success: boolean; is_ignored: boolean }>(
    `${BASE}/${nodeId}/mentions/${mentionId}/unignore`,
  );
  return response.data;
}
