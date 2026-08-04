/**
 * Dedicated persistence worker.
 *
 * IndexedDB writes for a 100+ MB workspace database block the main thread for
 * several seconds. Running those writes in this worker keeps the UI responsive
 * while the local SQLite snapshot is being saved.
 */

import { saveWorkspaceDatabase } from '../persistence/indexedDb';

interface PersistWorkerGlobal {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: unknown) => void;
}

const ctx = self as unknown as PersistWorkerGlobal;

ctx.onmessage = async (event: MessageEvent<unknown>) => {
  const msg = event.data as {
    type: 'persist';
    id: number;
    workspaceId: string;
    data: Uint8Array;
  };

  if (msg.type !== 'persist') return;

  try {
    await saveWorkspaceDatabase(msg.workspaceId, msg.data);
    ctx.postMessage({ type: 'persist-done', id: msg.id });
  } catch (err) {
    ctx.postMessage({
      type: 'persist-error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
