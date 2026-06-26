/**
 * Activity API functions
 *
 * For node activity tracking and link click tracking
 */
import api from '@/api/client';

const BASE = '/activity';

// ==================== Types ====================

export type NodeActivityAction =
  | 'created'
  | 'edited'
  | 'link_inserted'
  | 'archived'
  | 'unarchived'
  | 'type_added'
  | 'type_removed'
  | 'property_changed'
  | 'moved'
  | 'deleted';

export interface NodeActivity {
  nodeUuid: string;
  node_id: number; // deprecated: use node_uuid
  node_uuid: string;
  action: NodeActivityAction;
  details?: string;
  target_node_id?: number; // deprecated: use target_node_uuid
  target_node_uuid?: string;
  target_node_name?: string;
  create_date: string;
}

export interface NodeActivityCreate {
  node_uuid: string;
  action: string;
  details?: string;
  target_node_uuid?: string;
}

export interface LinkClick {
  source_node_id: number; // deprecated: use source_node_uuid
  source_node_uuid: string;
  target_node_id: number; // deprecated: use target_node_uuid
  target_node_uuid: string;
  node_link_uuid?: string | null; // UUID of the specific link instance
  click_count: number;
  last_click_date?: string | null;
}

export interface LinkClickHistory {
  nodeUuid: string;
  source_node_id: number; // deprecated: use source_node_uuid
  source_node_uuid: string;
  target_node_id: number; // deprecated: use target_node_uuid
  target_node_uuid: string;
  node_link_uuid?: string | null;
  click_date: string;
}

// ==================== Node Activity ====================

/**
 * Get activity log for a node
 */
export async function getNodeActivity(nodeUuid: string, limit = 50): Promise<NodeActivity[]> {
  const response = await api.get<NodeActivity[]>(`${BASE}/node/${nodeUuid}`, {
    params: { limit },
  });
  return response.data;
}

/**
 * Create a new activity entry for a node
 */
export async function createNodeActivity(data: NodeActivityCreate): Promise<NodeActivity> {
  const response = await api.post<NodeActivity>(`${BASE}/node/${data.node_uuid}`, data);
  return response.data;
}

/**
 * Delete an activity entry
 */
export async function deleteNodeActivity(nodeUuid: string, activityId: string): Promise<void> {
  await api.delete(`${BASE}/node/${nodeUuid}/${activityId}`);
}

// ==================== Link Click Tracking ====================

/**
 * Track a link click
 * @param sourceNodeUuid - The node containing the link
 * @param targetNodeUuid - The target node being linked to
 * @param nodeLinkUuid - Optional UUID of the specific link instance
 */
export async function trackLinkClick(
  sourceNodeUuid: string,
  targetNodeUuid: string,
  nodeLinkUuid?: string
): Promise<LinkClick> {
  const response = await api.post<LinkClick>(`${BASE}/link/click`, {
    source_node_uuid: sourceNodeUuid,
    target_node_uuid: targetNodeUuid,
    node_link_uuid: nodeLinkUuid,
  });
  return response.data;
}

/**
 * Get all link click counts from a source node
 */
export async function getLinkClicks(sourceNodeUuid: string): Promise<LinkClick[]> {
  const response = await api.get<LinkClick[]>(`${BASE}/link/clicks/${sourceNodeUuid}`);
  return response.data;
}

/**
 * Get click count for a specific link
 */
export async function getLinkClick(
  sourceNodeUuid: string,
  targetNodeUuid: string
): Promise<LinkClick> {
  const response = await api.get<LinkClick>(
    `${BASE}/link/click/${sourceNodeUuid}/${targetNodeUuid}`
  );
  return response.data;
}

/**
 * Reset click counter for a specific link
 */
export async function resetLinkClick(
  sourceNodeUuid: string,
  targetNodeUuid: string
): Promise<void> {
  await api.post(`${BASE}/link/reset/${sourceNodeUuid}/${targetNodeUuid}`);
}

/**
 * Get click history for a specific link (individual click records with timestamps)
 */
export async function getLinkClickHistory(
  sourceNodeUuid: string,
  targetNodeUuid: string,
  limit = 100
): Promise<LinkClickHistory[]> {
  const response = await api.get<LinkClickHistory[]>(
    `${BASE}/link/history/${sourceNodeUuid}/${targetNodeUuid}`,
    { params: { limit } }
  );
  return response.data;
}
