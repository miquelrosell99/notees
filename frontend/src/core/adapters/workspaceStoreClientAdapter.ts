/**
 * Registry for async worker-backed workspace store clients.
 *
 * This lives alongside the synchronous `workspaceStoreAdapter` during the
 * migration to a Web Worker architecture. Callers that have been converted to
 * the async API use this registry; legacy callers continue to use the
 * synchronous store registry.
 */

import { getOrCreateWorkspaceStore } from './workspaceStoreAdapter';
import type { Transport } from '../transport';
import { createWorkspaceStoreClient } from '../worker/WorkspaceStoreClient';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';
import { loadWorkspaceDatabase } from '../persistence/indexedDb';

interface ClientEntry {
  client: IWorkspaceStoreClient;
  actorId: string;
}

const clientRegistry = new Map<string, ClientEntry>();

function isWorkerSupported(): boolean {
  if (typeof Worker === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
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
  transport?: Transport
): Promise<IWorkspaceStoreClient> {
  const existing = clientRegistry.get(workspaceId);
  if (existing && existing.actorId === actorId) {
    return existing.client;
  }

  if (existing) {
    existing.client.close();
    clientRegistry.delete(workspaceId);
  }

  const client = createWorkspaceStoreClient();

  if (isWorkerSupported()) {
    let dbBytes: Uint8Array | undefined;
    if (isRealBrowser()) {
      const saved = await loadWorkspaceDatabase(workspaceId);
      if (saved) {
        dbBytes = saved;
      }
    }
    await client.init(workspaceId, actorId, { dbBytes });
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

export async function closeWorkspaceStoreClient(workspaceId: string): Promise<void> {
  const entry = clientRegistry.get(workspaceId);
  if (!entry) return;
  entry.client.close();
  clientRegistry.delete(workspaceId);
}
