/**
 * Nodes API functions
 */
import api from './client';
import type {
  Node,
  NodeCreate,
  NodeUpdate,
  NodesResponse,
  Backlink,
  BacklinksResponse,
  LinkedReference,
  LinkedReferencesResponse,
} from '@/types/api';

const BASE = '/nodes';

/**
 * List nodes with optional filters
 * 
 * @param params.pages_only - Only return pages (no blocks)
 * @param params.parent_id - Only return children of this node
 * @param params.tag_id - Only return nodes with this tag
 * @param params.type_filters - Comma-separated type IDs to filter by
 */
export async function listNodes(params?: {
  pages_only?: boolean;
  parent_id?: number;
  tag_id?: number;
  type_filters?: string;
}): Promise<Node[]> {
  const response = await api.get<NodesResponse>(BASE, { params });
  return response.data.nodes;
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
 * Create a new node
 */
export async function createNode(data: NodeCreate): Promise<Node> {
  const response = await api.post<Node>(BASE, data);
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
export async function listDailyPages(): Promise<Node[]> {
  const response = await api.get<NodesResponse>(`${BASE}/daily/list`);
  return response.data.nodes;
}

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
 * Get all archived pages
 */
export async function getArchivedPages(): Promise<Node[]> {
  const response = await api.get<{ pages: Node[] }>(`${BASE}/archived`);
  return response.data.pages;
}

/**
 * Get all nodes with a specific type
 */
export async function getNodesWithType(typeId: number): Promise<Node[]> {
  const response = await api.get<NodesResponse>(`${BASE}/types/${typeId}/nodes`);
  return response.data.nodes;
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
 * Get backlinks to a node
 */
export async function getBacklinks(
  nodeId: number,
  includeInherited = true
): Promise<Backlink[]> {
  const response = await api.get<BacklinksResponse>(`${BASE}/${nodeId}/backlinks`, {
    params: { include_inherited: includeInherited },
  });
  return response.data.backlinks;
}

/**
 * Get linked references to a node with context
 */
export async function getLinkedReferences(nodeId: number): Promise<LinkedReference[]> {
  const response = await api.get<LinkedReferencesResponse>(
    `${BASE}/${nodeId}/linked-references`
  );
  return response.data.linked_references;
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
 * Search nodes by name
 * 
 * @param query - Search query string
 * @param type_filters - Optional comma-separated type IDs to filter results
 */
export async function searchNodes(query: string, type_filters?: string): Promise<Node[]> {
  const response = await api.get<NodesResponse>(`${BASE}/search`, {
    params: { q: query, type_filters },
  });
  return response.data.nodes;
}

/**
 * List all types (nodes that can categorize other nodes)
 */
export async function listTypes(): Promise<Node[]> {
  const response = await api.get<NodesResponse>(`${BASE}/types`);
  return response.data.nodes;
}

/**
 * Search for types by name
 */
export async function searchTypes(query: string): Promise<Node[]> {
  const response = await api.get<NodesResponse>(`${BASE}/types/search`, {
    params: { q: query },
  });
  return response.data.nodes;
}

/**
 * Add a type to a node (sets the "types" property)
 */
export async function addType(nodeId: number, typeNodeId: number): Promise<Node> {
  const response = await api.post<Node>(`${BASE}/${nodeId}/types`, {
    type_node_id: typeNodeId,
  });
  return response.data;
}

/**
 * Remove a type from a node
 */
export async function removeType(nodeId: number, typeNodeId: number): Promise<Node> {
  const response = await api.delete<Node>(`${BASE}/${nodeId}/types/${typeNodeId}`);
  return response.data;
}

/**
 * List tasks
 */
export async function listTasks(includeComplete = false): Promise<Node[]> {
  const response = await api.get<NodesResponse>(`${BASE}/tasks`, {
    params: { include_complete: includeComplete },
  });
  return response.data.nodes;
}

// ==================== Graph ====================

/**
 * Graph node for visualization
 */
export interface GraphNode {
  id: number;
  title: string;
  type: 'page' | 'block';
  tags: string[];
  types: number[];
  properties: Record<string, unknown>;
  is_daily: boolean;
  created_at?: string;
  backlink_count?: number;
  internal_link_count?: number;
}

/**
 * Graph link for visualization
 */
export interface GraphLink {
  source: number;
  target: number;
  type: 'parent' | 'reference';
}

/**
 * Graph data response
 */
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/**
 * Get graph data for visualization
 */
export async function getGraphData(): Promise<GraphData> {
  const response = await api.get<GraphData>(`${BASE}/graph`);
  return response.data;
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
  const response = await api.get<{ property_backlinks: PropertyBacklink[] }>(
    `${BASE}/${nodeId}/property-backlinks`
  );
  return response.data.property_backlinks;
}

// ==================== Comments ====================

/**
 * Comment node - a node attached to another node as a comment
 */
export interface Comment {
  id: number;
  uuid: string;
  name: string;
  icon: string | null;
  parent_id: number | null;
  sequence: number;
  collapsed: boolean;
  create_date: string;
  write_date: string;
  children?: Comment[];
}

/**
 * Response with list of comments
 */
export interface CommentsResponse {
  comments: Comment[];
  comment_count: number;
}

/**
 * Get all comments for a node
 */
export async function getComments(nodeId: number): Promise<CommentsResponse> {
  const response = await api.get<CommentsResponse>(`${BASE}/${nodeId}/comments`);
  return response.data;
}

/**
 * Create a new comment on a node
 */
export async function createComment(nodeId: number, name: string): Promise<Comment> {
  const response = await api.post<Comment>(`${BASE}/${nodeId}/comments`, { name });
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
 * Text link info with is_tag flag
 */
export interface TextLink {
  id: number;
  source_node_id: number;
  target_node_id: number;
  is_tag: boolean;
  position: number;
}

/**
 * Get all text links from a node with is_tag info
 */
export async function getTextLinks(nodeId: number): Promise<TextLink[]> {
  const response = await api.get<{ links: TextLink[] }>(`${BASE}/${nodeId}/text-links`);
  return response.data.links;
}

/**
 * Add a tag link from a node to a target page
 */
export async function addTagLink(nodeId: number, targetNodeId: number): Promise<TextLink> {
  const response = await api.post<TextLink>(`${BASE}/${nodeId}/tag-links`, {
    target_node_id: targetNodeId,
  });
  return response.data;
}

/**
 * Remove a tag link (converts back to regular link)
 */
export async function removeTagLink(nodeId: number, targetId: number): Promise<void> {
  await api.delete(`${BASE}/${nodeId}/tag-links/${targetId}`);
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
  is_type: boolean;
  is_daily: boolean;
  is_monthly: boolean;
  is_yearly: boolean;
  create_date: string;
  write_date: string;
  open_date: string;
}

/**
 * Get recently opened pages, ordered by open_date DESC
 */
export async function getRecentPages(limit: number = 10): Promise<RecentPage[]> {
  const response = await api.get<{ nodes: RecentPage[] }>(`${BASE}/recents`, { params: { limit } });
  return response.data.nodes;
}

// ============== Favorites (DB-backed) ==============

/**
 * Get the list of favorite page IDs
 */
export async function getFavorites(): Promise<number[]> {
  const response = await api.get<{ favorites: number[] }>(`${BASE}/favorites`);
  return response.data.favorites;
}

/**
 * Set the entire list of favorite page IDs
 */
export async function setFavorites(favorites: number[]): Promise<number[]> {
  const response = await api.put<{ status: string; favorites: number[] }>(`${BASE}/favorites`, { favorites });
  return response.data.favorites;
}

/**
 * Add a page to favorites
 */
export async function addFavorite(nodeId: number): Promise<number[]> {
  const response = await api.post<{ status: string; favorites: number[] }>(`${BASE}/favorites/${nodeId}`);
  return response.data.favorites;
}

/**
 * Remove a page from favorites
 */
export async function removeFavorite(nodeId: number): Promise<number[]> {
  const response = await api.delete<{ status: string; favorites: number[] }>(`${BASE}/favorites/${nodeId}`);
  return response.data.favorites;
}

/**
 * Reorder favorites
 */
export async function reorderFavorites(fromIndex: number, toIndex: number): Promise<number[]> {
  const response = await api.put<{ status: string; favorites: number[] }>(`${BASE}/favorites/reorder`, {
    from_index: fromIndex,
    to_index: toIndex,
  });
  return response.data.favorites;
}