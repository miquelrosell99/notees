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

const BASE = '/nodes';
const SHARES_BASE = '/shares';
const PUBLIC_BASE = '/public/n';

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
 * List shares for a node
 */
export async function listNodeShares(nodeId: number): Promise<SharesResponse> {
  const response = await api.get<SharesResponse>(`${BASE}/${nodeId}/shares`);
  return response.data;
}

/**
 * List all shares in the current workspace
 */
export async function listWorkspaceShares(): Promise<SharesResponse> {
  const response = await api.get<SharesResponse>(SHARES_BASE);
  return response.data;
}

/**
 * Delete (revoke) a share
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
