import { openWorkspaceDatabase } from '../db/connection';
import { saveWorkspaceDatabase, deleteWorkspaceDatabase } from '../persistence/indexedDb';
import { SyncEngine, type SyncEngineCallbacks } from '../sync';
import { WorkspaceStore } from '../store';
import type { Transport } from '../transport';

interface RegistryEntry {
  store: WorkspaceStore;
  syncEngine: SyncEngine;
}

const registry = new Map<string, RegistryEntry>();
const pendingOpens = new Map<string, Promise<WorkspaceStore>>();

export interface WorkspaceStoreInitOptions {
  syncCallbacks?: SyncEngineCallbacks;
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
  const existing = registry.get(workspaceId);
  if (existing) {
    // If the same workspace is being opened for a different actor, the persisted
    // local state (favorites, watermarks, etc.) is actor-specific. Re-create the
    // store so the correct actor is used and stale anonymous/login state is not
    // reused.
    if (existing.store.getActorId() === actorId) {
      return existing.store;
    }
    existing.syncEngine.stopAutoSync();
    registry.delete(workspaceId);
    await deleteWorkspaceDatabase(workspaceId);
  }

  const db = await openWorkspaceDatabase(workspaceId);
  const store = new WorkspaceStore(db, workspaceId, actorId, {
    onPersist: async (data) => {
      await saveWorkspaceDatabase(workspaceId, data);
    },
  });
  const syncEngine = new SyncEngine(store, transport, options.syncCallbacks);
  registry.set(workspaceId, { store, syncEngine });

  // Initialize performs a one-time version check and may trigger a hard rebuild
  // of derived state when the applier version has changed. It then runs the
  // first sync. Opening a workspace should not fail just because the network is
  // unavailable, so initialization errors are caught and logged rather than
  // rejecting the open promise. Awaiting initialization lets callers (e.g. the
  // workspace loading overlay) know exactly when the first sync is complete.
  await syncEngine.initialize().catch((err) => {
    console.error(`Initial sync failed for workspace ${workspaceId}:`, err);
  });

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

  entry.syncEngine.stopAutoSync();
  const bytes = entry.store.getDb().export();
  await saveWorkspaceDatabase(workspaceId, bytes);
  registry.delete(workspaceId);
}

export async function syncWorkspace(workspaceId: string): Promise<void> {
  const entry = registry.get(workspaceId);
  if (!entry) {
    throw new Error(`Workspace ${workspaceId} is not open`);
  }
  await entry.syncEngine.syncOnce();
}

export async function forceResyncWorkspace(workspaceId: string): Promise<void> {
  const entry = registry.get(workspaceId);
  if (!entry) {
    throw new Error(`Workspace ${workspaceId} is not open`);
  }
  await entry.syncEngine.forceResync();
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
    entry.syncEngine.stopAutoSync();
    registry.delete(workspaceId);
  }
  await deleteWorkspaceDatabase(workspaceId);
}
