import { openWorkspaceDatabase } from '../db/connection';
import { saveWorkspaceDatabase } from '../persistence/indexedDb';
import { SyncEngine } from '../sync';
import { WorkspaceStore } from '../store';
import type { Transport } from '../transport';
import { UndoManager } from '../undo';

interface RegistryEntry {
  store: WorkspaceStore;
  syncEngine: SyncEngine;
}

const registry = new Map<string, RegistryEntry>();

export async function getOrCreateWorkspaceStore(
  workspaceId: string,
  actorId: string,
  transport: Transport
): Promise<WorkspaceStore> {
  const existing = registry.get(workspaceId);
  if (existing) return existing.store;

  const db = await openWorkspaceDatabase(workspaceId);
  const store = new WorkspaceStore(db, workspaceId, actorId, {
    onPersist: async (data) => {
      await saveWorkspaceDatabase(workspaceId, data);
    },
  });
  UndoManager.getOrCreateUndoManager(workspaceId, store);
  const syncEngine = new SyncEngine(store, transport);
  registry.set(workspaceId, { store, syncEngine });

  // Kick off an initial sync in the background; opening a workspace should not
  // fail just because the network is unavailable.
  void syncEngine.syncOnce().catch((err) => {
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
