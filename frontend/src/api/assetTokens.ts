/**
 * Asset token management.
 * 
 * Provides short-lived tokens for asset access instead of passing JWTs in URLs.
 * Tokens are cached and automatically refreshed when they expire.
 */
import api from '@/api/client';
import { getLogger } from '@/utils/logger';

const log = getLogger('asset-tokens');

interface AssetToken {
  token: string;
  expires_at: string;
}

interface CachedAssetToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedAssetToken>();

// Buffer before expiry to refresh tokens (milliseconds)
const TOKEN_REFRESH_BUFFER_MS = 60_000;

/**
 * Extract the JWT ``exp`` claim from an asset token.
 * Falls back to the server-provided expires_at when the token isn't a JWT.
 */
function getTokenExpiresAt(token: string, serverExpiresAt: number): number {
  try {
    const payloadBase64 = token.split('.')[1];
    if (!payloadBase64) return serverExpiresAt;
    const payload = JSON.parse(atob(payloadBase64)) as { exp?: number };
    if (typeof payload.exp === 'number') {
      return payload.exp * 1000;
    }
  } catch {
    // Ignore malformed tokens and trust the server timestamp
  }
  return serverExpiresAt;
}

/**
 * Get a short-lived asset token for accessing an asset.
 *
 * Tokens are cached and automatically refreshed before they expire. The cache
 * TTL is derived from the JWT ``exp`` claim so it stays in sync with the
 * backend even if clocks drift.
 *
 * @param assetUuid - The asset UUID
 * @returns The asset access token
 */
export async function getAssetToken(assetUuid: string): Promise<string> {
  const cached = tokenCache.get(assetUuid);
  const now = Date.now();

  // Return cached token if still valid beyond the refresh buffer
  if (cached && cached.expiresAt > now + TOKEN_REFRESH_BUFFER_MS) {
    return cached.token;
  }

  // Request new short-lived token
  log.debug(`Requesting asset token for ${assetUuid}`);
  const response = await api.post<AssetToken>(`/assets/${assetUuid}/token`);
  const serverExpiresAt = new Date(response.data.expires_at).getTime();
  const expiresAt = getTokenExpiresAt(response.data.token, serverExpiresAt);

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
