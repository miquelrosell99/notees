/**
 * Tests for workspace worker init:
 * opening a persisted database at an older user_version must flush the
 * migrated database exactly once (so migrations don't re-run every load);
 * opening an already-current database must not persist.
 * persist-data notifications must transfer their buffer (not clone it).
 *
 * The worker module is loaded with a stubbed `self` so the real handleInit
 * runs in-process and its postMessage traffic can be inspected.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { Database } from 'sql.js';
import { createTestDatabase } from '../../__tests__/helpers';
import { createDatabase } from '../../db/connection';
import type { WorkerMessage, WorkerResponse } from '../workerProtocol';

interface PostedMessage {
  message: WorkerMessage | WorkerResponse;
  transfer?: Transferable[];
}

const posted: PostedMessage[] = [];

function messages(): Array<WorkerMessage | WorkerResponse> {
  return posted.map((p) => p.message);
}

type OnMessage = (event: { data: unknown }) => Promise<void>;

function onmessage(): OnMessage {
  return (self as unknown as { onmessage: OnMessage }).onmessage;
}

function currentUserVersion(db: Database): number {
  return db.exec('PRAGMA user_version')[0].values[0][0] as number;
}

async function initWith(dbBytes: Uint8Array, id: number): Promise<void> {
  posted.length = 0;
  await onmessage()({
    data: { type: 'init', id, workspaceId: 'ws-init', actorId: 'actor-init', dbBytes },
  });
}

describe('workspaceWorker init persistence', () => {
  beforeAll(async () => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
    // The worker module binds self.onmessage on import; stub the worker
    // global first so the real handler runs in-process.
    vi.stubGlobal('self', {
      postMessage: (
        message: WorkerMessage | WorkerResponse,
        options?: Transferable[] | { transfer?: Transferable[] },
      ) => {
        const transfer = Array.isArray(options) ? options : options?.transfer;
        posted.push({ message, transfer });
      },
      onmessage: undefined,
    });
    await import('../workspaceWorker');
  });

  it('persists exactly once with the migrated DB when dbBytes are at an older user_version', async () => {
    const db = await createTestDatabase();
    const currentVersion = currentUserVersion(db);
    // Simulate a database persisted before the latest migrations shipped.
    db.exec('PRAGMA user_version = 15');
    const oldBytes = db.export();
    db.close();

    await initWith(oldBytes, 1);

    expect(messages().some((m) => m.type === 'init-done')).toBe(true);
    const persistMsgs = posted.filter((p) => p.message.type === 'persist-data');
    expect(persistMsgs).toHaveLength(1);

    // The buffer is transferred, not structured-cloned.
    const persistData = persistMsgs[0].message as Extract<WorkerMessage, { type: 'persist-data' }>;
    expect(persistMsgs[0].transfer).toEqual([persistData.data.buffer]);

    const persistedDb = await createDatabase(persistData.data);
    try {
      expect(currentUserVersion(persistedDb)).toBe(currentVersion);
    } finally {
      persistedDb.close();
    }
  });

  it('does not persist when the database is already at the current user_version', async () => {
    const db = await createTestDatabase();
    const currentBytes = db.export();
    db.close();

    await initWith(currentBytes, 2);

    expect(messages().some((m) => m.type === 'init-done')).toBe(true);
    expect(messages().filter((m) => m.type === 'persist-data')).toHaveLength(0);
  });
});
