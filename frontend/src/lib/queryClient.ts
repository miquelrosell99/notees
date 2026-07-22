/**
 * React Query client configuration with offline persistence
 */
import { QueryClient, QueryCache, type Query } from '@tanstack/react-query';
import { get, set, del } from 'idb-keyval';
import { isApiError } from '@/api/client';
import type { Persister, PersistedClient } from '@tanstack/react-query-persist-client';

import { useNotificationStore } from '@/stores/notificationStore';
import { useUndoStore } from '@/stores/undoStore';
import { useEncryptionStore } from '@/stores/encryptionStore';
import { encryptString, decryptString, type EncryptedPayload } from '@/utils/encryption';

/**
 * Extract user-friendly error message from various error types
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const apiError = isApiError(error) ? error : undefined;
    if (apiError?.response?.data && typeof apiError.response.data === 'object') {
      const data = apiError.response.data as { detail?: string; message?: string };
      return data.detail || data.message || error.message;
    }
    return error.message;
  }
  return 'An unexpected error occurred';
}

/**
 * Global mutation error handler
 */
function onMutationError(error: Error) {
  const message = getErrorMessage(error);
  useNotificationStore.getState().error('Operation failed', message);
}

/**
 * Global query error handler — only surfaces non-auth errors so routine
 * 401/403 responses (handled by the auth flow) don't spam the user.
 */
function onQueryError(error: Error, query: unknown) {
  const status = isApiError(error) ? error.response?.status : undefined;
  if (status && (status === 401 || status === 403)) return;
  if ((query as { meta?: { skipGlobalError?: boolean } })?.meta?.skipGlobalError) return;
  const message = getErrorMessage(error);
  useNotificationStore.getState().error('Failed to load data', message);
}

/**
 * Query-key prefixes that are cross-workspace (auth, settings, workspace list,
 * admin, notifications). Everything else is assumed to be scoped to the current
 * workspace and is invalidated when switching workspaces.
 */
const CROSS_WORKSPACE_PREFIXES = new Set([
  'auth',
  'settings',
  'workspaces',
  'admin',
  'notifications',
]);

export function isWorkspaceScopedQuery(query: Query): boolean {
  const key = query.queryKey as unknown[];
  if (!key || key.length === 0) return false;
  return !CROSS_WORKSPACE_PREFIXES.has(key[0] as string);
}

/**
 * Invalidate workspace-scoped queries without blowing away the entire cache.
 * This keeps auth, settings, and the workspace list intact across switches.
 */
export function invalidateWorkspaceQueries(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ predicate: isWorkspaceScopedQuery });
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: onQueryError,
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: (failureCount, error) => {
        const status = isApiError(error) ? error.response?.status : undefined;
        if (status && status >= 400 && status < 500) {
          return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      throwOnError: false,
    },
    mutations: {
      retry: 0,
      onError: onMutationError,
      onSuccess: () => {
        debouncedRefreshStack();
      },
    },
  },
});

// ─── Debounced undo-stack refresh ─────────────────────────────────

let refreshStackTimer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_STACK_DEBOUNCE_MS = 500;

function debouncedRefreshStack(): void {
  if (refreshStackTimer) {
    clearTimeout(refreshStackTimer);
  }
  refreshStackTimer = setTimeout(() => {
    refreshStackTimer = null;
    useUndoStore.getState().refreshStack().catch((error) => {
      console.error('[queryClient] Failed to refresh undo stack:', error);
    });
  }, REFRESH_STACK_DEBOUNCE_MS);
}

// ─── Offline Persistence ─────────────────────────────────────────

const PERSIST_KEY = 'notees-query-cache';
const MAX_PERSIST_SIZE = 5 * 1024 * 1024; // 5 MB
const PERSIST_DEBOUNCE_MS = 2000;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingClient: PersistedClient | null = null;

export const asyncStoragePersister: Persister = {
  async persistClient(client: PersistedClient): Promise<void> {
    pendingClient = client;
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const toPersist = pendingClient;
      pendingClient = null;
      if (!toPersist) return;

      const serialized = JSON.stringify(toPersist);
      if (serialized.length > MAX_PERSIST_SIZE) {
        console.warn('[queryClient] Cache too large to persist (>5 MB), skipping IndexedDB write.');
        return;
      }

      set(PERSIST_KEY, serialized).catch((err) => {
        console.error('[queryClient] Failed to persist query cache:', err);
      });
    }, PERSIST_DEBOUNCE_MS);
  },
  async restoreClient(): Promise<PersistedClient | undefined> {
    const value = await get(PERSIST_KEY);
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as PersistedClient;
      } catch {
        return undefined;
      }
    }
    return undefined;
  },
  async removeClient(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      pendingClient = null;
    }
    await del(PERSIST_KEY);
  },
};

/**
 * Creates a persister that encrypts the dehydrated query cache with the given
 * AES-GCM key before writing to IndexedDB.
 */
export function createEncryptedPersister(key: CryptoKey): Persister {
  return {
    async persistClient(client: PersistedClient): Promise<void> {
      const serialized = JSON.stringify(client);
      const payload = await encryptString(serialized, key);
      await set(PERSIST_KEY, JSON.stringify(payload));
    },
    async restoreClient(): Promise<PersistedClient | undefined> {
      const raw = await get(PERSIST_KEY);
      if (typeof raw !== 'string') return undefined;
      try {
        const payload = JSON.parse(raw) as EncryptedPayload;
        const decrypted = await decryptString(payload, key);
        return JSON.parse(decrypted) as PersistedClient;
      } catch {
        return undefined;
      }
    },
    async removeClient(): Promise<void> {
      await del(PERSIST_KEY);
    },
  };
}

// ─── Per-workspace cache persistence ───────────────────────────────

let persistWorkspaceUuid: string | null = null;

/**
 * Set the workspace UUID that subsequent cache persist/restore operations
 * should target. Call this whenever the active workspace changes.
 */
export function setPersistWorkspaceUuid(uuid: string | null): void {
  persistWorkspaceUuid = uuid;
  // Changing workspaces invalidates any pending debounced write: the captured
  // client belongs to the previous workspace and would either be written to the
  // wrong key or overwrite the new workspace's cache.
  if (workspacePersistTimer) {
    clearTimeout(workspacePersistTimer);
    workspacePersistTimer = null;
    workspacePendingClient = null;
  }
}

function getWorkspaceCacheKey(): string {
  return persistWorkspaceUuid ? `${PERSIST_KEY}-${persistWorkspaceUuid}` : PERSIST_KEY;
}

function getWorkspaceEncryptionKey(): CryptoKey | null {
  if (!persistWorkspaceUuid) return null;
  return useEncryptionStore.getState().getKey(persistWorkspaceUuid);
}

let workspacePersistTimer: ReturnType<typeof setTimeout> | null = null;
let workspacePendingClient: PersistedClient | null = null;

async function writeWorkspaceClient(
  client: PersistedClient,
  key: CryptoKey | null,
  cacheKey: string,
): Promise<void> {
  const serialized = JSON.stringify(client);

  if (serialized.length > MAX_PERSIST_SIZE) {
    console.warn('[queryClient] Cache too large to persist (>5 MB), skipping IndexedDB write.');
    return;
  }

  if (key) {
    const payload = await encryptString(serialized, key);
    await set(cacheKey, JSON.stringify(payload));
  } else {
    await set(cacheKey, serialized);
  }
}

/**
 * Workspace-aware persister.
 *
 * - Each workspace gets its own IndexedDB cache key.
 * - If the active workspace is encrypted and unlocked, the cache is encrypted
 *   with that workspace's in-memory key.
 * - If the workspace is not encrypted or locked, the cache is stored plaintext.
 * - Writes are debounced by 2 s so bursts of cache mutations (e.g. during
 *   editing) do not block the main thread with repeated JSON.stringify +
 *   IndexedDB serialisation.
 *
 * This prevents cross-workspace cache contamination and lets encryption be
 * opt-in per workspace.
 */
export const workspaceAwarePersister: Persister = {
  async persistClient(client: PersistedClient): Promise<void> {
    const key = getWorkspaceEncryptionKey();
    const cacheKey = getWorkspaceCacheKey();

    workspacePendingClient = client;
    if (workspacePersistTimer) {
      clearTimeout(workspacePersistTimer);
    }

    workspacePersistTimer = setTimeout(() => {
      workspacePersistTimer = null;
      const toPersist = workspacePendingClient;
      workspacePendingClient = null;
      if (!toPersist) return;
      void writeWorkspaceClient(toPersist, key, cacheKey);
    }, PERSIST_DEBOUNCE_MS);
  },

  async restoreClient(): Promise<PersistedClient | undefined> {
    const key = getWorkspaceEncryptionKey();
    const cacheKey = getWorkspaceCacheKey();
    const raw = await get(cacheKey);
    if (typeof raw !== 'string') return undefined;

    if (key) {
      try {
        const payload = JSON.parse(raw) as EncryptedPayload;
        const decrypted = await decryptString(payload, key);
        return JSON.parse(decrypted) as PersistedClient;
      } catch {
        return undefined;
      }
    }

    try {
      return JSON.parse(raw) as PersistedClient;
    } catch {
      return undefined;
    }
  },

  async removeClient(): Promise<void> {
    if (workspacePersistTimer) {
      clearTimeout(workspacePersistTimer);
      workspacePersistTimer = null;
      workspacePendingClient = null;
    }
    const cacheKey = getWorkspaceCacheKey();
    await del(cacheKey);
  },
};
