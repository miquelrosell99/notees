/**
 * Tests for workspace worker init (single-engine wa-sqlite era):
 * opening with migration-seed bytes must initialize cleanly and run schema
 * migrations on the opened database. In jsdom (memory persistence mode) the
 * durable state lives in the file/VFS itself, so no persist-data messages
 * are emitted; the IndexedDB fallback mode is covered separately below.
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

  it('falls back to IndexedDB persistence when a real browser has no OPFS', async () => {
    // Simulate Zen/Firefox-with-dom.fs.disabled: navigator exists, no
    // storage.getDirectory, IndexedDB present, not jsdom.
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/155.0' });
    vi.stubGlobal('indexedDB', {});
    try {
      const db = await createTestDatabase();
      const bytes = db.export();
      db.close();

      await initWith(bytes, 10, 'ws-idb-fallback');
      expect(messages().some((m) => m.type === 'init-done')).toBe(true);
      expect(messages().some((m) => m.type === 'error')).toBe(false);

      // persistNow must ship a full-database snapshot to the main thread,
      // transferred (not cloned) for large workspaces.
      posted.length = 0;
      await onmessage()({ data: { type: 'mutate', id: 11, method: 'persistNow', args: [] } });
      const persistMsgs = posted.filter(
        (p) => (p.message as { type: string }).type === 'persist-data'
      );
      expect(persistMsgs).toHaveLength(1);
      const snapshot = (persistMsgs[0].message as { bytes: Uint8Array }).bytes;
      expect(new TextDecoder().decode(snapshot.slice(0, 16))).toBe('SQLite format 3\0');
      expect(persistMsgs[0].transfer).toContain(snapshot.buffer);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('choosePersistenceMode', () => {
  it('prefers opfs whenever available', async () => {
    const { choosePersistenceMode } = await import('../workspaceWorker');
    expect(
      choosePersistenceMode({ opfsAvailable: true, realBrowser: true, idbAvailable: true })
    ).toBe('opfs');
  });

  it('falls back to indexeddb in a real browser without opfs', async () => {
    const { choosePersistenceMode } = await import('../workspaceWorker');
    expect(
      choosePersistenceMode({ opfsAvailable: false, realBrowser: true, idbAvailable: true })
    ).toBe('indexeddb');
  });

  it('fails loud in a real browser with neither opfs nor indexeddb', async () => {
    const { choosePersistenceMode } = await import('../workspaceWorker');
    expect(() =>
      choosePersistenceMode({ opfsAvailable: false, realBrowser: true, idbAvailable: false })
    ).toThrow(/cannot persist local data/);
  });

  it('uses ephemeral memory outside real browsers (jsdom/tests)', async () => {
    const { choosePersistenceMode } = await import('../workspaceWorker');
    expect(
      choosePersistenceMode({ opfsAvailable: false, realBrowser: false, idbAvailable: false })
    ).toBe('memory');
  });
});
