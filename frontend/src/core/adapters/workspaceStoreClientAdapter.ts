/**
 * Registry for async worker-backed workspace store clients.
 *
 * This lives alongside the synchronous `workspaceStoreAdapter` during the
 * migration to a Web Worker architecture. Callers that have been converted to
 * the async API use this registry; legacy callers continue to use the
 * synchronous store registry.
 */

import {
  getOrCreateWorkspaceStore,
  getActiveWorkspaceStore,
  pushWorkspace,
  pullWorkspace,
} from './workspaceStoreAdapter';
import type { Transport } from '../transport';
import { createWorkspaceStoreClient } from '../worker/WorkspaceStoreClient';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';
import { loadWorkspaceDatabase } from '../persistence/indexedDb';
import { getLogger } from '@/utils/logger';

const log = getLogger('workspaceStoreClientAdapter');

const LOAD_PERSISTED_DB_TIMEOUT_MS = 60_000;

interface ClientEntry {
  client: IWorkspaceStoreClient;
  actorId: string;
}

const clientRegistry = new Map<string, ClientEntry>();
const pendingOpens = new Map<string, Promise<IWorkspaceStoreClient>>();

function isWorkerSupported(): boolean {
  if (typeof Worker === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
  // jsdom does not implement Web Workers reliably.
  return !navigator.userAgent.includes('jsdom');
}

function isRealBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
  return !navigator.userAgent.includes('jsdom');
}

/**
 * Open or return an existing async workspace store client for the given
 * workspace. The client runs sql.js in a Web Worker in real browsers. In tests
 * it wraps the same synchronous WorkspaceStore so migrated and legacy callers
 * see the same data during the transition.
 */
export async function getOrCreateWorkspaceStoreClient(
  workspaceId: string,
  actorId: string,
  transport?: Transport,
  options?: { dbBytes?: Uint8Array }
): Promise<IWorkspaceStoreClient> {
  const existing = clientRegistry.get(workspaceId);
  if (existing && existing.actorId === actorId && !existing.client.isClosed()) {
    return existing.client;
  }

  if (existing) {
    existing.client.close();
    clientRegistry.delete(workspaceId);
  }

  // Serialize concurrent open attempts for the same workspace so only one
  // worker/client is created and all callers receive the same instance.
  const previous = pendingOpens.get(workspaceId);
  const current = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // Ignore previous failure; proceed with a fresh open.
      }
    }
    return openWorkspaceStoreClient(workspaceId, actorId, transport, options);
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

async function openWorkspaceStoreClient(
  workspaceId: string,
  actorId: string,
  transport?: Transport,
  options?: { dbBytes?: Uint8Array }
): Promise<IWorkspaceStoreClient> {
  const client = createWorkspaceStoreClient();

  if (isWorkerSupported()) {
    let dbBytes = options?.dbBytes;
    if (isRealBrowser() && !dbBytes) {
      // Loading a large or corrupted IndexedDB record can hang the main thread
      // indefinitely. Time it out and fall back to a fresh local database; the
      // server operation log is the source of truth so data is not lost.
      performance.mark('workspace-client:idb-read-start');
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const loadPromise = (async () => {
        const result = await loadWorkspaceDatabase(workspaceId);
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        return result;
      })();
      const timeoutPromise = new Promise<undefined>((resolve) => {
        timeoutHandle = setTimeout(() => {
          log.warn(`Loading persisted DB for ${workspaceId} timed out; falling back to fresh local DB`);
          resolve(undefined);
        }, LOAD_PERSISTED_DB_TIMEOUT_MS);
      });
      const saved = await Promise.race([loadPromise, timeoutPromise]);
      performance.mark('workspace-client:idb-read-end');
      performance.measure('workspace-client:idb-read', 'workspace-client:idb-read-start', 'workspace-client:idb-read-end');
      if (saved) {
        dbBytes = saved;
      }
    }
    performance.mark('workspace-client:worker-init-start');
    await client.init(workspaceId, actorId, { dbBytes });
    performance.mark('workspace-client:worker-init-end');
    performance.measure('workspace-client:worker-init', 'workspace-client:worker-init-start', 'workspace-client:worker-init-end');
  } else {
    // Test mode: share the synchronous store so legacy and migrated callers
    // observe the same database during the transition.
    if (!transport) {
      throw new Error('Transport is required to open a workspace store client');
    }
    const store = await getOrCreateWorkspaceStore(workspaceId, actorId, transport);
    await client.init(workspaceId, actorId, { store });
  }

  clientRegistry.set(workspaceId, { client, actorId });
  return client;
}

export function getWorkspaceStoreClient(workspaceId: string): IWorkspaceStoreClient | undefined {
  return clientRegistry.get(workspaceId)?.client;
}

/**
 * Return the client for the first open workspace.
 *
 * This is a convenience for imperative code paths that do not have access to a
 * workspace ID. In normal operation only one workspace is open at a time.
 */
export function getActiveWorkspaceStoreClient(): IWorkspaceStoreClient | undefined {
  return clientRegistry.values().next().value?.client;
}

export async function closeWorkspaceStoreClient(workspaceId: string): Promise<void> {
  const entry = clientRegistry.get(workspaceId);
  if (!entry) return;
  entry.client.close();
  clientRegistry.delete(workspaceId);
}

/**
 * Push any pending local operations for the active workspace to the server.
 *
 * This is the async-client entry point for the command palette and other
 * production UI. It delegates to the sync adapter which owns the SyncEngine.
 */
export async function pushActiveWorkspace(): Promise<void> {
  const store = getActiveWorkspaceStore();
  if (!store) {
    throw new Error('No workspace is open');
  }
  return pushWorkspace(store.getWorkspaceId());
}

/**
 * Pull the active workspace down from the server, discarding local derived state.
 */
export async function pullActiveWorkspace(): Promise<void> {
  const store = getActiveWorkspaceStore();
  if (!store) {
    throw new Error('No workspace is open');
  }
  return pullWorkspace(store.getWorkspaceId());
}
