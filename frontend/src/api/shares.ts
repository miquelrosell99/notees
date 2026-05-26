/**
 * Shares API functions
 */
import api from './client';

export interface Share {
  share_uuid: string;
  node_id: number;
  created_at: string;
  expiry_date: string | null;
  url: string;
  node_name?: string | null;
  node_uuid?: string | null;
}

export interface SharesResponse {
  shares: Share[];
}

export interface PublicSharedNode {
  node: {
    id: number;
    uuid: string;
    name: string;
    icon: string | null;
    color: string | null;
    is_page: boolean;
    is_class: boolean;
    is_day: boolean;
    is_month: boolean;
    is_year: boolean;
    is_template: boolean;
    parent_id: number | null;
    sequence: number;
    class_ids: number[];
    create_date: string;
    write_date: string;
  };
  children: (PublicSharedNode['node'] & { depth: number })[];
}

export interface UserShare {
  share_id: number;
  node_id: number;
  shared_with_user_id: number;
  shared_with_username: string;
  permission: 'read' | 'write';
  created_at: string;
  created_by: number;
}

export interface UserSharesResponse {
  shares: UserShare[];
}

export interface ShareInboxItem {
  share_id: number;
  node_id: number;
  node_uuid: string;
  node_name: string;
  node_icon: string | null;
  is_page: boolean;
  permission: 'read' | 'write';
  shared_at: string;
  shared_by: {
    user_id: number;
    username: string;
  };
  workspace: {
    id: number;
    name: string;
    uuid: string;
  };
}

export interface ShareInboxResponse {
  items: ShareInboxItem[];
}

export interface WorkspaceMember {
  user_id: number;
  username: string;
  user_uuid: string;
  role: string;
  joined_at: string | null;
}

export interface WorkspaceMembersResponse {
  members: WorkspaceMember[];
}

const BASE = '/nodes';
const SHARES_BASE = '/shares';
const PUBLIC_BASE = '/public/n';
const WORKSPACES_BASE = '/workspaces';

/**
 * Create a public share for a node
 */
export async function createShare(
  nodeId: number,
  expiryDate?: string | null
): Promise<Share> {
  const response = await api.post<Share>(`${BASE}/${nodeId}/shares`, {
    expiry_date: expiryDate ?? null,
  });
  return response.data;
}

/**
 * List public shares for a node
 */
export async function listNodeShares(nodeId: number): Promise<SharesResponse> {
  const response = await api.get<SharesResponse>(`${BASE}/${nodeId}/shares`);
  return response.data;
}

/**
 * List all public shares in the current workspace
 */
export async function listWorkspaceShares(): Promise<SharesResponse> {
  const response = await api.get<SharesResponse>(SHARES_BASE);
  return response.data;
}

/**
 * Delete (revoke) a public share
 */
export async function deleteShare(shareUuid: string): Promise<{ success: boolean }> {
  const response = await api.delete<{ success: boolean }>(`${SHARES_BASE}/${shareUuid}`);
  return response.data;
}

/**
 * Get a publicly shared node (no auth required)
 */
export async function getPublicSharedNode(shareUuid: string): Promise<PublicSharedNode> {
  const response = await api.get<PublicSharedNode>(`${PUBLIC_BASE}/${shareUuid}`);
  return response.data;
}

// ============ Node User Shares ============

/**
 * Share a node with a specific user
 */
export async function createUserShare(
  nodeId: number,
  username: string,
  permission: 'read' | 'write' = 'read'
): Promise<UserShare> {
  const response = await api.post<UserShare>(`${BASE}/${nodeId}/user-shares`, {
    username,
    permission,
  });
  return response.data;
}

/**
 * List user shares for a node
 */
export async function listNodeUserShares(nodeId: number): Promise<UserSharesResponse> {
  const response = await api.get<UserSharesResponse>(`${BASE}/${nodeId}/user-shares`);
  return response.data;
}

/**
 * Revoke a user share
 */
export async function deleteUserShare(shareId: number): Promise<{ success: boolean }> {
  const response = await api.delete<{ success: boolean }>(`${BASE}/user-shares/${shareId}`);
  return response.data;
}

/**
 * Get share inbox (all nodes shared with current user)
 */
export async function getShareInbox(): Promise<ShareInboxResponse> {
  const response = await api.get<ShareInboxResponse>(`${SHARES_BASE}/inbox`);
  return response.data;
}

// ============ Workspace Members ============

/**
 * Invite a user to a workspace
 */
export async function inviteWorkspaceMember(
  workspaceUuid: string,
  username: string,
  role: string = 'viewer'
): Promise<{ status: string; username: string; role: string }> {
  const response = await api.post(`${WORKSPACES_BASE}/${workspaceUuid}/members`, {
    username,
    role,
  });
  return response.data;
}

/**
 * List workspace members
 */
export async function listWorkspaceMembers(workspaceUuid: string): Promise<WorkspaceMembersResponse> {
  const response = await api.get<WorkspaceMembersResponse>(
    `${WORKSPACES_BASE}/${workspaceUuid}/members`
  );
  return response.data;
}

/**
 * Update a member's role
 */
export async function updateWorkspaceMember(
  workspaceUuid: string,
  memberUserId: number,
  role: string
): Promise<{ status: string; role: string }> {
  const response = await api.put(`${WORKSPACES_BASE}/${workspaceUuid}/members/${memberUserId}`, {
    role,
  });
  return response.data;
}

/**
 * Remove a member from a workspace
 */
export async function removeWorkspaceMember(
  workspaceUuid: string,
  memberUserId: number
): Promise<{ status: string }> {
  const response = await api.delete(`${WORKSPACES_BASE}/${workspaceUuid}/members/${memberUserId}`);
  return response.data;
}
