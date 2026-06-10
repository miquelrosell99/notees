/**
 * Asset token management.
 * 
 * Provides short-lived tokens for asset access instead of passing JWTs in URLs.
 * Tokens are cached and automatically refreshed when they expire.
 */
import api from '@/api/client';
import { getLogger } from '../utils/logger';

const log = getLogger('asset-tokens');

interface AssetToken {
  token: string;
  expires_at: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Get a short-lived asset token for accessing an asset.
 * 
 * Tokens are cached and automatically refreshed when they expire.
 * 
 * @param assetUuid - The asset UUID
 * @returns The asset access token
 */
export async function getAssetToken(assetUuid: string): Promise<string> {
  const cached = tokenCache.get(assetUuid);
  const now = Date.now();
  
  // Return cached token if valid for at least 30 more seconds
  if (cached && cached.expiresAt > now + 30000) {
    return cached.token;
  }
  
  // Request new short-lived token
  log.debug(`Requesting asset token for ${assetUuid}`);
  const response = await api.post<AssetToken>(`/assets/${assetUuid}/token`);
  const expiresAt = new Date(response.data.expires_at).getTime();
  
  tokenCache.set(assetUuid, { token: response.data.token, expiresAt });
  log.debug(`Asset token cached until ${new Date(expiresAt).toISOString()}`);
  
  return response.data.token;
}

/**
 * Get asset URL synchronously with an optional pre-fetched token.
 * 
 * @param uuid - The asset UUID
 * @param assetToken - Optional pre-fetched asset token
 * @returns The URL to access the asset
 */
export function getAssetUrlSync(uuid: string, assetToken?: string): string {
  if (assetToken) {
    return `/api/assets/${uuid}?asset_token=${encodeURIComponent(assetToken)}`;
  }
  return `/api/assets/${uuid}`;
}

/**
 * Clear the token cache for a specific asset or all assets.
 * 
 * @param assetUuid - Optional asset UUID to clear (clears all if not specified)
 */
export function clearAssetTokenCache(assetUuid?: string): void {
  if (assetUuid) {
    tokenCache.delete(assetUuid);
  } else {
    tokenCache.clear();
  }
}
