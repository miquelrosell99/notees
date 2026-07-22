/**
 * Registry for async worker-backed workspace store clients.
 *
 * This lives alongside the synchronous `workspaceStoreAdapter` during the
 * migration to a Web Worker architecture. Callers that have been converted to
 * the async API use this registry; legacy callers continue to use the
 * synchronous store registry.
 */

import type { Transport } from '../transport';
import {
  createWorkspaceStoreClient,
  type IWorkspaceStoreClient,
} from '../worker/WorkspaceStoreClient';
import { loadWorkspaceDatabase } from '../persistence/indexedDb';

interface ClientEntry {
  client: IWorkspaceStoreClient;
  actorId: string;
}

const clientRegistry = new Map<string, ClientEntry>();

function isRealBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof navigator === 'undefined') return false;
  return !navigator.userAgent.includes('jsdom');
}

/**
 * Open or return an existing async workspace store client for the given
 * workspace. The client runs sql.js in a Web Worker in real browsers.
 */
export async function getOrCreateWorkspaceStoreClient(
  workspaceId: string,
  actorId: string,
  transport?: Transport
): Promise<IWorkspaceStoreClient> {
  void transport;
  const existing = clientRegistry.get(workspaceId);
  if (existing && existing.actorId === actorId) {
    return existing.client;
  }

  if (existing) {
    existing.client.close();
    clientRegistry.delete(workspaceId);
  }

  const client = createWorkspaceStoreClient();
  let dbBytes: Uint8Array | undefined;
  if (isRealBrowser()) {
    const saved = await loadWorkspaceDatabase(workspaceId);
    if (saved) {
      dbBytes = saved;
    }
  }

  await client.init(workspaceId, actorId, { dbBytes });
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
