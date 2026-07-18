import { createDatabase } from '../db/connection';
import { deriveUserWrappingKey, unwrapWorkspaceKey } from '../crypto';
import { loadWorkspaceDatabase, saveWorkspaceDatabase } from '../persistence/indexedDb';
import { SyncEngine } from '../sync';
import { WorkspaceStore } from '../store';
import type { Transport } from '../transport';

interface RegistryEntry {
  store: WorkspaceStore;
  syncEngine: SyncEngine;
  key: CryptoKey;
}

interface WrappedKeySpec {
  wrappedKey: { ciphertext: string; iv: string };
  userId: string;
  secret: string;
}

function isWrappedKeySpec(value: CryptoKey | WrappedKeySpec): value is WrappedKeySpec {
  return (
    typeof value === 'object' &&
    value !== null &&
    'wrappedKey' in value &&
    'userId' in value &&
    'secret' in value
  );
}

const registry = new Map<string, RegistryEntry>();

export async function getOrCreateWorkspaceStore(
  workspaceId: string,
  actorId: string,
  key: CryptoKey,
  transport: Transport
): Promise<WorkspaceStore>;
export async function getOrCreateWorkspaceStore(
  workspaceId: string,
  actorId: string,
  spec: WrappedKeySpec,
  transport: Transport
): Promise<WorkspaceStore>;
export async function getOrCreateWorkspaceStore(
  workspaceId: string,
  actorId: string,
  keyOrSpec: CryptoKey | WrappedKeySpec,
  transport: Transport
): Promise<WorkspaceStore> {
  const existing = registry.get(workspaceId);
  if (existing) return existing.store;

  let key: CryptoKey;
  if (isWrappedKeySpec(keyOrSpec)) {
    const wrappingKey = await deriveUserWrappingKey(keyOrSpec.userId, keyOrSpec.secret);
    key = await unwrapWorkspaceKey(keyOrSpec.wrappedKey, wrappingKey);
  } else {
    key = keyOrSpec;
  }

  const saved = await loadWorkspaceDatabase(workspaceId);
  const db = await createDatabase(saved);
  const store = new WorkspaceStore(db, workspaceId, actorId);
  const syncEngine = new SyncEngine(store, key, transport);
  registry.set(workspaceId, { store, syncEngine, key });

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
