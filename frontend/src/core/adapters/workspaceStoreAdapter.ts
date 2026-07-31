import { createDatabase } from '../db/connection';
import { loadWorkspaceDatabase, saveWorkspaceDatabase, deleteWorkspaceDatabase } from '../persistence/indexedDb';
import { SyncEngine, type SyncEngineCallbacks } from '../sync';
import { WorkspaceStore } from '../store';
import type { Transport } from '../transport';
import { createWorkspaceStoreClient } from '../worker/WorkspaceStoreClient';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';
import {
  closeWorkspaceStoreClient,
  getOrCreateWorkspaceStoreClient,
} from './workspaceStoreClientAdapter';
import {
  clearFavoritesCache,
  subscribeFavorites,
  warmFavoritesCache,
} from '@/core/favoritesCache';

interface RegistryEntry {
  store: WorkspaceStore;
  syncEngine: SyncEngine;
  client: IWorkspaceStoreClient;
  unsubscribeFavorites: () => void;
}

const registry = new Map<string, RegistryEntry>();
const pendingOpens = new Map<string, Promise<WorkspaceStore>>();

export interface WorkspaceOpenProgress {
  phase: string;
  message: string;
}

export interface WorkspaceStoreInitOptions {
  syncCallbacks?: SyncEngineCallbacks;
  onOpenProgress?: (progress: WorkspaceOpenProgress) => void;
}

function isWorkerSupported(): boolean {
  if (typeof Worker === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
  // jsdom does not implement Web Workers reliably.
  return !navigator.userAgent.includes('jsdom');
}

function isRealBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return !navigator.userAgent.includes('jsdom');
}

export async function getOrCreateWorkspaceStore(
  workspaceId: string,
  actorId: string,
  transport: Transport,
  options: WorkspaceStoreInitOptions = {}
): Promise<WorkspaceStore> {
  // Serialize concurrent open attempts for the same workspace. Without this,
  // overlapping calls (e.g. from test files that reuse the same workspaceId)
  // can race on registry deletion/replacement and end up with different store
  // instances for the same logical workspace.
  const previous = pendingOpens.get(workspaceId);
  const current = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // Ignore previous failure; proceed with a fresh open.
      }
    }
    return openWorkspaceStore(workspaceId, actorId, transport, options);
  })();
  pendingOpens.set(workspaceId, current);
  try {
    return await current;
  } finally {
    if (pendingOpens.get(workspaceId) === current) {
      pendingOpens.delete(workspaceId);
    }
  }
}

async function openWorkspaceStore(
  workspaceId: string,
  actorId: string,
  transport: Transport,
  options: WorkspaceStoreInitOptions = {}
): Promise<WorkspaceStore> {
  const { onOpenProgress } = options;
  const report = (phase: string, message: string) => {
    performance.mark(`workspace-open:${phase}`);
    onOpenProgress?.({ phase, message });
  };

  const existing = registry.get(workspaceId);
  if (existing) {
    // If the same workspace is being opened for a different actor, the persisted
    // local state (favorites, watermarks, etc.) is actor-specific. Re-create the
    // store so the correct actor is used and stale anonymous/login state is not
    // reused.
    if (existing.store.getActorId() === actorId) {
      return existing.store;
    }
    existing.unsubscribeFavorites();
    clearFavoritesCache(workspaceId);
    existing.syncEngine.stopAutoSync();
    existing.client.close();
    registry.delete(workspaceId);
    await deleteWorkspaceDatabase(workspaceId);
  }

  report('loading-persisted-db', 'Loading local workspace data…');
  // Load the persisted database once and reuse the bytes for both the legacy
  // synchronous store and the new worker-backed client. This avoids two
  // concurrent/sequential IndexedDB reads, which can timeout on large workspaces.
  const savedBytes = isRealBrowser() ? await loadWorkspaceDatabase(workspaceId) : undefined;
  const db = await createDatabase(savedBytes);
  // In worker mode the worker-owned database is authoritative; do not let the
  // legacy synchronous store overwrite the persisted copy with its own (stale)
  // exported bytes. In jsdom/tests there is no worker, so the synchronous store
  // is the one and only copy and must persist itself.
  const store = new WorkspaceStore(db, workspaceId, actorId, {
    onPersist: isWorkerSupported()
      ? undefined
      : async (data) => {
          await saveWorkspaceDatabase(workspaceId, data);
        },
  });

  // The SyncEngine operates on the worker-owned database in real browsers. In
  // jsdom/tests the inline client wraps this same synchronous store so legacy
  // and migrated callers observe the same data.
  report('worker-init', 'Starting database engine…');
  let client: IWorkspaceStoreClient;
  if (isWorkerSupported()) {
    client = await getOrCreateWorkspaceStoreClient(workspaceId, actorId, transport, {
      dbBytes: savedBytes,
    });
  } else {
    client = createWorkspaceStoreClient();
    await client.init(workspaceId, actorId, { store });
  }

  report('opening-store', 'Preparing workspace…');
  const syncEngine = new SyncEngine(client, transport, options.syncCallbacks);
  const unsubscribeFavorites = subscribeFavorites(workspaceId, client);
  registry.set(workspaceId, { store, syncEngine, client, unsubscribeFavorites });

  // Prime the synchronous favorites cache before the workspace is considered
  // fully opened. Failures are logged but must not block workspace open.
  report('warming-cache', 'Loading favorites…');
  await warmFavoritesCache(workspaceId, client);

  // Initialize performs a one-time version check and may trigger a hard rebuild
  // of derived state when the applier version has changed. It then runs the
  // first sync. Initialization errors are propagated so the workspace loading
  // overlay can show the error overlay and let the user retry.
  report('sync-initialize', 'Connecting to server…');
  await syncEngine.initialize();

  report('ready', 'Ready');
  return store;
}

export function getWorkspaceStore(workspaceId: string): WorkspaceStore | undefined {
  return registry.get(workspaceId)?.store;
}

/**
 * Return the first open workspace store. This is used by code paths that do not
 * have access to the route params (e.g. imperative batch helpers); in normal
 * operation only one workspace is open at a time.
 */
export function getActiveWorkspaceStore(): WorkspaceStore | undefined {
  return registry.values().next().value?.store;
}

export function getWorkspaceSyncEngine(workspaceId: string): SyncEngine | undefined {
  return registry.get(workspaceId)?.syncEngine;
}

async function persistWorkspace(workspaceId: string, client: IWorkspaceStoreClient): Promise<void> {
  const bytes = await client.export();
  await saveWorkspaceDatabase(workspaceId, bytes);
}

export async function closeWorkspaceStore(workspaceId: string): Promise<void> {
  const entry = registry.get(workspaceId);
  if (!entry) return;

  entry.unsubscribeFavorites();
  clearFavoritesCache(workspaceId);
  entry.syncEngine.stopAutoSync();
  await persistWorkspace(workspaceId, entry.client);
  entry.client.close();
  registry.delete(workspaceId);
  await closeWorkspaceStoreClient(workspaceId);
}

export async function syncWorkspace(workspaceId: string): Promise<void> {
  const entry = registry.get(workspaceId);
  if (!entry) {
    throw new Error(`Workspace ${workspaceId} is not open`);
  }
  await entry.syncEngine.syncOnce();
  await persistWorkspace(workspaceId, entry.client);
}

export async function forceResyncWorkspace(workspaceId: string): Promise<void> {
  const entry = registry.get(workspaceId);
  if (!entry) {
    throw new Error(`Workspace ${workspaceId} is not open`);
  }
  await entry.syncEngine.forceResync();
  await persistWorkspace(workspaceId, entry.client);
}

/**
 * Discard all local state for a workspace and check out fresh from the server.
 *
 * This is stronger than force re-sync: it wipes the in-browser IndexedDB/OPFS
 * copy of the workspace database, clears the in-memory registry, and re-opens
 * the workspace so it rebuilds from the server operation log. Use it when local
 * derived state is corrupt, stale, or out of sync with the server.
 */
export async function resetWorkspaceStore(workspaceId: string): Promise<void> {
  const entry = registry.get(workspaceId);
  if (entry) {
    entry.unsubscribeFavorites();
    clearFavoritesCache(workspaceId);
    entry.syncEngine.stopAutoSync();
    entry.client.close();
    registry.delete(workspaceId);
  }
  await closeWorkspaceStoreClient(workspaceId);
  await deleteWorkspaceDatabase(workspaceId);
}
