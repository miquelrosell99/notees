/**
 * Shares API functions
 */
import api from '@/api/client';
import type { PaginatedResponse } from '@/types/api';

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
    display_name: string;
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
    properties: Record<string, unknown>;
  };
  children: (Omit<PublicSharedNode['node'], 'properties'> & { depth: number })[];
  property_definitions: Array<{
    id: number;
    uuid: string;
    name: string;
    icon: string | null;
    type: string;
    multi: boolean;
    is_system: boolean;
    scope: string;
    node_id: number | null;
    icon_visibility: string;
    validation_rules: Record<string, unknown> | null;
    create_date: string;
    write_date: string;
    class_filters: number[];
    options: Array<{
      id: number;
      name: string;
      icon: string | null;
      color: string | null;
      sequence: number;
    }>;
  }>;
}

export interface UserShare {
  share_id: number;
  node_id: number;
  shared_with_user_id: number;
  shared_with_email: string;
  permission: 'read' | 'write' | 'comment';
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
    email: string;
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
  user_id: number | null;
  email: string;
  user_uuid: string | null;
  role: string;
  joined_at: string | null;
  status?: string | null;
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
  nodeUuid: string,
  expiryDate?: string | null,
  password?: string | null
): Promise<Share> {
  const response = await api.post<Share>(`${BASE}/${nodeUuid}/shares`, {
    expiry_date: expiryDate ?? null,
    password: password ?? null,
  });
  return response.data;
}

/**
 * List public shares for a node
 */
export async function listNodeShares(nodeUuid: string): Promise<SharesResponse> {
  const response = await api.get<SharesResponse>(`${BASE}/${nodeUuid}/shares`);
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
export async function getPublicSharedNode(shareUuid: string, password?: string): Promise<PublicSharedNode> {
  const response = await api.get<PublicSharedNode>(`${PUBLIC_BASE}/${shareUuid}`, {
    params: password ? { password } : undefined,
  });
  return response.data;
}

// ============ Node User Shares ============

/**
 * Share a node with a specific user
 */
export async function createUserShare(
  nodeUuid: string,
  email: string,
  permission: 'read' | 'write' | 'comment' = 'read'
): Promise<UserShare> {
  const response = await api.post<UserShare>(`${BASE}/${nodeUuid}/user-shares`, {
    email,
    permission,
  });
  return response.data;
}

/**
 * List user shares for a node
 */
export async function listNodeUserShares(nodeUuid: string): Promise<UserSharesResponse> {
  const response = await api.get<UserSharesResponse>(`${BASE}/${nodeUuid}/user-shares`);
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
export async function getShareInbox(
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<ShareInboxItem>> {
  const response = await api.get<PaginatedResponse<ShareInboxItem>>(`${SHARES_BASE}/inbox`, {
    params: { page, page_size },
  });
  return response.data;
}

// ============ Workspace Members ============

/**
 * Invite a user to a workspace
 */
export async function inviteWorkspaceMember(
  workspaceUuid: string,
  email: string,
  role: string = 'viewer'
): Promise<{ status: string; username: string; role: string }> {
  const response = await api.post(`${WORKSPACES_BASE}/${workspaceUuid}/members`, {
    email,
    role,
  });
  return response.data;
}

/**
 * List workspace members
 */
export async function listWorkspaceMembers(
  workspaceUuid: string,
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<WorkspaceMember>> {
  const response = await api.get<PaginatedResponse<WorkspaceMember>>(
    `${WORKSPACES_BASE}/${workspaceUuid}/members`,
    { params: { page, page_size } },
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

export async function removePendingInvite(
  workspaceUuid: string,
  email: string
): Promise<{ status: string }> {
  const response = await api.delete(`${WORKSPACES_BASE}/${workspaceUuid}/pending-invites/${encodeURIComponent(email)}`);
  return response.data;
}
