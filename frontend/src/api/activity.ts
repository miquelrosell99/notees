/**
 * Activity API functions
 * 
 * For node activity tracking and link click tracking
 */
import api from './client';

const BASE = '/activity';

// ==================== Types ====================

export interface NodeActivity {
  id: number;
  node_id: number;
  action: 'created' | 'edited' | 'link_added' | 'link_removed' | 'link_inserted' | 'archived' | 'unarchived' | 'type_added' | 'type_removed' | 'property_changed' | 'moved';
  details?: string;
  target_node_id?: number;
  target_node_name?: string;
  create_date: string;
}

export interface NodeActivityCreate {
  node_id: number;
  action: string;
  details?: string;
  target_node_id?: number;
}

export interface LinkClick {
  source_node_id: number;
  target_node_id: number;
  node_link_uuid?: string | null;  // UUID of the specific link instance
  click_count: number;
  last_click_date?: string | null;
}

export interface LinkClickHistory {
  id: number;
  source_node_id: number;
  target_node_id: number;
  node_link_uuid?: string | null;
  click_date: string;
}

// ==================== Node Activity ====================

/**
 * Get activity log for a node
 */
export async function getNodeActivity(nodeId: number, limit = 50): Promise<NodeActivity[]> {
  const response = await api.get<NodeActivity[]>(`${BASE}/node/${nodeId}`, {
    params: { limit },
  });
  return response.data;
}

/**
 * Create a new activity entry for a node
 */
export async function createNodeActivity(data: NodeActivityCreate): Promise<NodeActivity> {
  const response = await api.post<NodeActivity>(`${BASE}/node/${data.node_id}`, data);
  return response.data;
}

/**
 * Delete an activity entry
 */
export async function deleteNodeActivity(nodeId: number, activityId: number): Promise<void> {
  await api.delete(`${BASE}/node/${nodeId}/${activityId}`);
}

// ==================== Link Click Tracking ====================

/**
 * Track a link click
 * @param sourceNodeId - The node containing the link
 * @param targetNodeId - The target node being linked to
 * @param nodeLinkUuid - Optional UUID of the specific link instance
 */
export async function trackLinkClick(
  sourceNodeId: number, 
  targetNodeId: number,
  nodeLinkUuid?: string
): Promise<LinkClick> {
  const response = await api.post<LinkClick>(`${BASE}/link/click`, {
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    node_link_uuid: nodeLinkUuid,
  });
  return response.data;
}

/**
 * Get all link click counts from a source node
 */
export async function getLinkClicks(sourceNodeId: number): Promise<LinkClick[]> {
  const response = await api.get<LinkClick[]>(`${BASE}/link/clicks/${sourceNodeId}`);
  return response.data;
}

/**
 * Get click count for a specific link
 */
export async function getLinkClick(sourceNodeId: number, targetNodeId: number): Promise<LinkClick> {
  const response = await api.get<LinkClick>(`${BASE}/link/click/${sourceNodeId}/${targetNodeId}`);
  return response.data;
}

/**
 * Reset click counter for a specific link
 */
export async function resetLinkClick(sourceNodeId: number, targetNodeId: number): Promise<void> {
  await api.post(`${BASE}/link/reset/${sourceNodeId}/${targetNodeId}`);
}

/**
 * Get click history for a specific link (individual click records with timestamps)
 */
export async function getLinkClickHistory(
  sourceNodeId: number, 
  targetNodeId: number,
  limit = 100
): Promise<LinkClickHistory[]> {
  const response = await api.get<LinkClickHistory[]>(
    `${BASE}/link/history/${sourceNodeId}/${targetNodeId}`,
    { params: { limit } }
  );
  return response.data;
}
