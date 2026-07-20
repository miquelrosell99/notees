import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { SyncEngine } from '../../sync';
import { MemoryRelay, MemoryTransport } from '../../transport';
import { deriveKey } from '../../crypto';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../helpers';

/**
 * Stress tests for SyncEngine catch-up and multi-client convergence.
 */
describe('SyncEngine stress', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  const opCount = () => {
    const env = process.env.NOTEES_STRESS_OPS;
    return env ? parseInt(env, 10) : 2_000;
  };

  const burstOps = () => {
    const env = process.env.NOTEES_STRESS_BURST_OPS;
    return env ? parseInt(env, 10) : 200;
  };

  const clientCount = () => {
    const env = process.env.NOTEES_STRESS_CLIENTS;
    return env ? parseInt(env, 10) : 4;
  };

  const catchUpTimeoutMs = (count: number) => Math.max(3_000, count * 1.5);

  it('catches up a client that is N operations behind within a bound', async () => {
    const workspaceId = uuidv7();
    const actorA = uuidv7();
    const actorB = uuidv7();
    const key = await deriveKey('test-password');
    const relay = new MemoryRelay();

    const dbA = await createTestDatabase();
    const storeA = new WorkspaceStore(dbA, workspaceId, actorA);
    const syncA = new SyncEngine(storeA, key, new MemoryTransport(relay, workspaceId));

    const count = opCount();
    for (let i = 0; i < count; i++) {
      storeA.createNode({ nodeId: uuidv7(), kind: 'block', parentId: null });
    }
    await syncA.push();

    const dbB = await createTestDatabase();
    const storeB = new WorkspaceStore(dbB, workspaceId, actorB);
    const syncB = new SyncEngine(storeB, key, new MemoryTransport(relay, workspaceId));

    const start = performance.now();
    await syncB.pull();
    const elapsed = performance.now() - start;

    const nodeRows = dbB.exec(`SELECT COUNT(*) AS count FROM node WHERE workspace_id = '${workspaceId}'`);
    expect(nodeRows[0].values[0][0]).toBe(count);
    expect(elapsed).toBeLessThan(catchUpTimeoutMs(count));
    console.log(`frontend catch_up(${count}) elapsed: ${elapsed.toFixed(1)}ms`);
  }, 30_000);

  it('converges multiple clients after a burst of operations', async () => {
    const workspaceId = uuidv7();
    const key = await deriveKey('test-password');
    const relay = new MemoryRelay();

    const clients: WorkspaceStore[] = [];
    const syncs: SyncEngine[] = [];
    const totalClients = clientCount();
    const perClientOps = burstOps();

    for (let i = 0; i < totalClients; i++) {
      const db = await createTestDatabase();
      const actorId = uuidv7();
      const store = new WorkspaceStore(db, workspaceId, actorId);
      clients.push(store);
      syncs.push(new SyncEngine(store, key, new MemoryTransport(relay, workspaceId)));
    }

    const start = performance.now();
    for (let i = 0; i < totalClients; i++) {
      for (let j = 0; j < perClientOps; j++) {
        clients[i].createNode({ nodeId: uuidv7(), kind: 'block', parentId: null });
      }
    }

    for (const sync of syncs) {
      await sync.push();
    }
    for (const sync of syncs) {
      await sync.pull();
    }
    for (const sync of syncs) {
      await sync.push();
    }
    for (const sync of syncs) {
      await sync.pull();
    }
    const elapsed = performance.now() - start;

    const totalOps = totalClients * perClientOps;
    console.log(
      `frontend convergence_burst(${totalClients} clients x ${perClientOps} ops): ${elapsed.toFixed(1)}ms`
    );

    const firstRows = clients[0].getDb().exec(
      `SELECT COUNT(*) AS count FROM node WHERE workspace_id = '${workspaceId}'`
    );
    const firstCount = firstRows[0].values[0][0] as number;
    expect(firstCount).toBe(totalOps);

    for (let i = 1; i < totalClients; i++) {
      const rows = clients[i].getDb().exec(
        `SELECT COUNT(*) AS count FROM node WHERE workspace_id = '${workspaceId}'`
      );
      expect(rows[0].values[0][0]).toBe(firstCount);
    }

    expect(elapsed).toBeLessThan(Math.max(10_000, totalOps * 3));
  }, 30_000);
});
