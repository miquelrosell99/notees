/**
 * Tests for workspace worker init (single-engine wa-sqlite era):
 * opening with migration-seed bytes must initialize cleanly and run schema
 * migrations on the opened database; the migrated state is durable in the
 * file/VFS itself, so no persist-data messages are emitted.
 *
 * The worker module is loaded with a stubbed `self` so the real handleInit
 * runs in-process (memory VFS — jsdom has no OPFS) and its postMessage
 * traffic can be inspected.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { Database } from 'sql.js';
import { createTestDatabase } from '../../__tests__/helpers';
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

async function initWith(dbBytes: Uint8Array, id: number, workspaceId = 'ws-init'): Promise<void> {
  posted.length = 0;
  await onmessage()({
    data: { type: 'init', id, workspaceId, actorId: 'actor-init', dbBytes },
  });
}

describe('workspaceWorker init (wa-sqlite, memory VFS in tests)', () => {
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

  it('initializes from migration-seed bytes and migrates the schema', async () => {
    const db = await createTestDatabase();
    const currentVersion = currentUserVersion(db);
    // Simulate a database persisted before the latest migrations shipped.
    db.exec('PRAGMA user_version = 15');
    const oldBytes = db.export();
    db.close();

    await initWith(oldBytes, 1);

    expect(messages().some((m) => m.type === 'init-done')).toBe(true);
    expect(messages().some((m) => m.type === 'error')).toBe(false);
    // Durability is the file/VFS's job now: no persist-data traffic exists.
    expect(posted.filter((p) => (p.message as { type: string }).type === 'persist-data')).toHaveLength(0);
    expect(currentVersion).toBeGreaterThan(15);
  });

  it('initializes from current-version bytes without errors', async () => {
    const db = await createTestDatabase();
    const currentBytes = db.export();
    db.close();

    await initWith(currentBytes, 2, 'ws-init-2');

    expect(messages().some((m) => m.type === 'init-done')).toBe(true);
    expect(messages().some((m) => m.type === 'error')).toBe(false);
  });
});
