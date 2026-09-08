import { createDatabase } from '../db/connection';
import { loadWorkspaceDatabase, saveWorkspaceDatabase, deleteWorkspaceDatabase } from '../persistence/indexedDb';
import { SyncEngine, type SyncEngineCallbacks } from '../sync';
import { ensureLocalWorkspace } from '../seed';
import { WorkspaceStore } from '../store';
import type { Transport } from '../transport';
import { createWorkspaceStoreClient } from '../worker/WorkspaceStoreClient';
import { electWorkspaceTab, type TabRole } from '../worker/tabLeadership';
import { startTabRpcServer, RemoteStoreClient, type TabRpcServer } from '../worker/tabRpc';
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
import { getConnectionMode } from '@/config/serverUrl';
import { useConnectionStore } from '@/stores/connectionStore';

interface RegistryEntry {
  store: WorkspaceStore;
  syncEngine: SyncEngine;
  client: IWorkspaceStoreClient;
  unsubscribeFavorites: () => void;
  /** Leader-tab RPC server for follower tabs; undefined on followers. */
  rpcServer?: TabRpcServer;
  /** True when this tab proxies to the leader tab's store (multi-tab). */
  isFollower: boolean;
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
  /**
   * Display name for the local user's personal seed page. Only used when the
   * workspace is opened in local mode (see `ensureLocalWorkspace`).
   */
  localUserDisplayName?: string;
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
    existing.rpcServer?.close();
    existing.client.close();
    registry.delete(workspaceId);
    await deleteWorkspaceDatabase(workspaceId);
  }

  report('loading-persisted-db', 'Loading local workspace data…');

  // Multi-tab election: one tab leads (worker + sync engine + IndexedDB
  // writes), follower tabs proxy to it over BroadcastChannel. On takeover
  // (leader tab closed) the simplest correct move is a reload: the tab
  // re-runs the normal open path as leader against the latest persisted
  // bytes. jsdom/tests have no Web Locks and always lead.
  const tabRole: TabRole = isRealBrowser()
    ? (
        await electWorkspaceTab(workspaceId, actorId, () => {
          window.location.reload();
        })
      ).role
    : 'leader';

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
  // and migrated callers observe the same data. Follower tabs proxy every
  // call to the leader tab instead of opening their own worker.
  report('worker-init', 'Starting database engine…');
  const isFollower = tabRole === 'follower';
  let client: IWorkspaceStoreClient;
  let rpcServer: TabRpcServer | undefined;
  if (isFollower) {
    client = new RemoteStoreClient();
    await client.init(workspaceId, actorId);
  } else if (isWorkerSupported()) {
    client = await getOrCreateWorkspaceStoreClient(workspaceId, actorId, transport, {
      dbBytes: savedBytes,
    });
    rpcServer = startTabRpcServer(client, workspaceId, actorId);
  } else {
    client = createWorkspaceStoreClient();
    await client.init(workspaceId, actorId, { store });
  }

  report('opening-store', 'Preparing workspace…');
  const syncEngine = new SyncEngine(client, transport, options.syncCallbacks);
  const unsubscribeFavorites = subscribeFavorites(workspaceId, client);
  registry.set(workspaceId, { store, syncEngine, client, unsubscribeFavorites, rpcServer, isFollower });

  // Prime the synchronous favorites cache before the workspace is considered
  // fully opened. Failures are logged but must not block workspace open.
  report('warming-cache', 'Loading favorites…');
  await warmFavoritesCache(workspaceId, client);

  // Initialize performs a one-time version check and may trigger a hard rebuild
  // of derived state when the applier version has changed. It then runs the
  // first sync. Initialization errors are propagated so the workspace loading
  // overlay can show the error overlay and let the user retry.
  // In local mode there is no server to sync with — the local op log is the
  // source of truth — so the initial sync (and its transport calls) is skipped.
  // Instead, the client seeds the workspace itself: there is no server-side
  // seed in local mode, and without it the workspace would boot empty (no
  // Inbox, no system classes). Idempotent: a no-op once content exists.
  // Follower tabs skip both: the leader tab owns the sync engine and seeds.
  if (isFollower) {
    report('ready', 'Ready');
    return store;
  }
  if (getConnectionMode(useConnectionStore.getState().healthy) !== 'local') {
    report('sync-initialize', 'Connecting to server…');
    await syncEngine.initialize();
  } else {
    report('seed-local-workspace', 'Preparing local workspace…');
    await ensureLocalWorkspace(client, actorId, options.localUserDisplayName ?? 'Local user');
  }

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

export async function closeWorkspaceStore(workspaceId: string): Promise<void> {
  const entry = registry.get(workspaceId);
  if (!entry) return;

  entry.unsubscribeFavorites();
  clearFavoritesCache(workspaceId);
  entry.syncEngine.stopAutoSync();
  entry.rpcServer?.close();
  entry.client.close();
  registry.delete(workspaceId);
  if (!entry.isFollower) {
    await closeWorkspaceStoreClient(workspaceId);
  }
}

/** True when this tab proxies to another (leader) tab for the workspace. */
export function isWorkspaceTabFollower(workspaceId: string): boolean {
  return registry.get(workspaceId)?.isFollower ?? false;
}

export async function syncWorkspace(workspaceId: string): Promise<void> {
  const entry = registry.get(workspaceId);
  if (!entry) {
    throw new Error(`Workspace ${workspaceId} is not open`);
  }
  await entry.syncEngine.syncOnce();
}

/**
 * Push any pending local operations to the server without pulling.
 */
export async function pushWorkspace(
  workspaceId: string,
  onProgress?: (progress: { sent: number; total: number }) => void
): Promise<void> {
  const entry = registry.get(workspaceId);
  if (!entry) {
    throw new Error(`Workspace ${workspaceId} is not open`);
  }
  await entry.syncEngine.push(onProgress);
}

/**
 * Pull the workspace down from the server, discarding local derived state.
 *
 * This wipes the in-browser IndexedDB/OPFS copy of the workspace database,
 * clears the in-memory registry, and re-opens the workspace so it rebuilds from
 * the server snapshot/operation log. Use it when local state looks corrupt or
 * out of sync with the server.
 */
export async function pullWorkspace(workspaceId: string): Promise<void> {
  const entry = registry.get(workspaceId);
  if (entry) {
    entry.unsubscribeFavorites();
    clearFavoritesCache(workspaceId);
    entry.syncEngine.stopAutoSync();
    entry.rpcServer?.close();
    entry.client.close();
    registry.delete(workspaceId);
  }
  await closeWorkspaceStoreClient(workspaceId);
  await deleteWorkspaceDatabase(workspaceId);
}
