/**
 * Assets API client.
 * 
 * Handles file uploads and downloads for images, audio, and other assets.
 *
 * Local-first split (Task 5): in local mode every operation is dispatched to
 * the local asset store (`localAssets.ts`) — blobs in IndexedDB, metadata via
 * the local op log — and no `/api/*` call is made (asset tokens included,
 * they are meaningless without a server).
 */
import api from '@/api/client';
import { getLogger } from '@/utils/logger';
import { getConnectionMode } from '@/config/serverUrl';
import { useConnectionStore } from '@/stores/connectionStore';
import { getActiveWorkspaceStoreClient } from '@/core/adapters/workspaceStoreClientAdapter';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { getAssetToken, getAssetUrlSync } from './assetTokens';
import {
  deleteLocalAsset,
  getLocalAssetInfo,
  getLocalAssetUrl,
  uploadLocalAsset,
} from './localAssets';

const log = getLogger('assets-api');

/** True when running without a configured server (see config/serverUrl). */
function isLocalMode(): boolean {
  return getConnectionMode(useConnectionStore.getState().healthy) === 'local';
}

/** The open workspace store client, required for all local asset operations. */
function requireLocalClient(): IWorkspaceStoreClient {
  const client = getActiveWorkspaceStoreClient();
  if (!client) {
    throw new Error('No local workspace is open');
  }
  return client;
}

/**
 * Asset category types.
 */
export type AssetCategory = 'image' | 'audio' | 'file';

/**
 * Asset response from the server.
 */
export interface Asset {
  uuid: string;
  node_id: number; // deprecated: use node_uuid
  node_uuid: string;
  filename: string;
  content_type: string;
  category: AssetCategory;
  size_bytes: number;
  url: string;
}

/**
 * List of assets response.
 */
export interface AssetListResponse {
  assets: Asset[];
  total: number;
}

/**
 * Supported content types for upload.
 */
export const SUPPORTED_CONTENT_TYPES = {
  // Images
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  // Audio
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/webm': '.webm',
};

/**
 * Upload a file as an asset.
 * 
 * @param file - The file to upload
 * @param parentId - Optional parent node ID to associate the asset with
 * @param existingNodeId - Optional existing node ID to convert to an asset (for empty blocks)
 * @param content - Optional content to set as the node's name when converting an existing node
 * @returns The created asset
 */
export async function uploadAsset(
  file: File,
  parentUuid?: string,
  existingNodeUuid?: string,
  content?: string,
): Promise<Asset> {
  if (isLocalMode()) {
    const asset = await uploadLocalAsset(requireLocalClient(), file, parentUuid, existingNodeUuid, content);
    log.info(`Asset uploaded locally: ${asset.uuid}`);
    return asset;
  }

  const formData = new FormData();
  formData.append('file', file);
  if (parentUuid !== undefined) formData.append('parent_uuid', parentUuid);
  if (existingNodeUuid !== undefined) formData.append('existing_node_uuid', existingNodeUuid);
  if (content !== undefined) formData.append('content', content);

  log.info(
    `Uploading asset: ${file.name} (${file.type}, ${file.size} bytes)${
      existingNodeUuid ? ` (converting node ${existingNodeUuid})` : ''
    }`
  );

  const response = await api.post<Asset>('/assets/upload', formData);

  log.info(`Asset uploaded: ${response.data.uuid}`);
  return response.data;
}

/**
 * Get asset URL for embedding in content (synchronous version).
 * 
 * This is the backward-compatible version that doesn't use asset tokens.
 * For new code, consider using useAssetUrl hook or getAssetUrlAsync.
 * 
 * Note: This still works but passes the asset UUID without a token.
 * The backend will fall back to Authorization header authentication.
 * 
 * @param assetUuid - The asset UUID
 * @returns The URL to access the asset
 */
export function getAssetUrl(assetUuid: string): string {
  // Return URL without token - will use Authorization header
  return `/api/assets/${assetUuid}`;
}

/**
 * Get asset URL with short-lived token (async version).
 * 
 * Uses short-lived asset tokens instead of passing JWTs in URLs.
 * Preferred for new code.
 * 
 * @param assetUuid - The asset UUID
 * @returns Promise resolving to the URL to access the asset with token
 */
export async function getAssetUrlAsync(assetUuid: string): Promise<string> {
  if (isLocalMode()) {
    // Bytes live in IndexedDB; return an object URL. The caller (AssetImage)
    // revokes it on unmount.
    return getLocalAssetUrl(requireLocalClient(), assetUuid);
  }
  try {
    const token = await getAssetToken(assetUuid);
    return getAssetUrlSync(assetUuid, token);
  } catch (error) {
    log.error(`Failed to get asset token for ${assetUuid}:`, error);
    // Fallback to URL without token (will use Authorization header)
    return `/api/assets/${assetUuid}`;
  }
}

/**
 * Get asset metadata.
 * 
 * @param assetUuid - The asset UUID
 * @returns Asset info
 */
export async function getAssetInfo(assetUuid: string): Promise<Asset> {
  if (isLocalMode()) {
    return getLocalAssetInfo(requireLocalClient(), assetUuid);
  }
  const response = await api.get<Asset>(`/assets/${assetUuid}/info`);
  return response.data;
}

/**
 * Delete an asset.
 * 
 * @param assetUuid - The asset UUID
 * @returns Success response
 */
export async function deleteAsset(assetUuid: string): Promise<{ success: boolean; deleted_file: boolean }> {
  if (isLocalMode()) {
    return deleteLocalAsset(requireLocalClient(), assetUuid);
  }
  const response = await api.delete<{ success: boolean; deleted_file: boolean }>(`/assets/${assetUuid}`);
  return response.data;
}

/**
 * List all assets in the current database.
 * 
 * @param page - Page number (1-indexed)
 * @param pageSize - Number of assets per page
 * @returns List of assets
 */
export async function listAssets(page: number = 1, pageSize: number = 50): Promise<AssetListResponse> {
  if (isLocalMode()) {
    // No server to list from; the local asset inventory lives in the workspace
    // graph (asset-class nodes), not behind this endpoint.
    throw new Error('Asset listing is not available in local mode');
  }
  const response = await api.get<AssetListResponse>('/assets/', {
    params: { page, page_size: pageSize },
  });
  return response.data;
}

/**
 * Check if a content type is supported for upload.
 * 
 * @param contentType - MIME type to check
 * @returns Whether the type is supported
 */
export function isSupportedAssetType(contentType: string): boolean {
  return contentType in SUPPORTED_CONTENT_TYPES;
}

/**
 * Get the asset category from content type.
 */
export function getAssetCategory(contentType: string): AssetCategory {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Get the maximum allowed file size in bytes.
 */
export const MAX_ASSET_SIZE = 50 * 1024 * 1024; // 50MB
