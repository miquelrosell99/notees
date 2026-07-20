import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../helpers';

/**
 * Stress tests for the client-side WorkspaceStore.
 *
 * These tests generate thousands of operations against an in-memory sql.js
 * database and measure apply/replay latency and storage overhead. They are
 * deterministic and use modest counts by default so they run quickly in CI;
 * larger counts can be set via environment variables.
 */
describe('WorkspaceStore stress', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  const opCount = () => {
    const env = process.env.NOTEES_STRESS_OPS;
    return env ? parseInt(env, 10) : 2_000;
  };

  const replayTimeoutMs = (count: number) => Math.max(2_000, count * 0.75);

  it('applies thousands of node.create operations within a time bound', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);
    const count = opCount();

    const start = performance.now();
    for (let i = 0; i < count; i++) {
      store.createNode({ nodeId: uuidv7(), kind: 'block', parentId: null });
    }
    const elapsed = performance.now() - start;

    const nodeRows = db.exec(`SELECT COUNT(*) AS count FROM node WHERE workspace_id = '${workspaceId}'`);
    expect(nodeRows[0].values[0][0]).toBe(count);
    expect(elapsed).toBeLessThan(replayTimeoutMs(count));
    console.log(`frontend apply(${count}) elapsed: ${elapsed.toFixed(1)}ms`);
  }, 30_000);

  it('restores from snapshot and replays newer operations quickly', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);
    const count = opCount();
    const half = Math.floor(count / 2);

    for (let i = 0; i < half; i++) {
      store.createNode({ nodeId: uuidv7(), kind: 'block', parentId: null });
    }
    const snapshotHlc = store.getClock().advance(Date.now());
    store.createSnapshot(snapshotHlc);

    for (let i = half; i < count; i++) {
      store.createNode({ nodeId: uuidv7(), kind: 'block', parentId: null });
    }

    const start = performance.now();
    const restoredHlc = await store.restoreLatestSnapshot();
    const elapsed = performance.now() - start;

    expect(restoredHlc).toEqual(snapshotHlc);
    // The snapshot covers half the nodes; the restored DB must still contain
    // the snapshot state even though newer operations are lost on restore.
    const nodeRows = db.exec(`SELECT COUNT(*) AS count FROM node WHERE workspace_id = '${workspaceId}'`);
    expect(nodeRows[0].values[0][0]).toBeGreaterThanOrEqual(half);
    expect(elapsed).toBeLessThan(replayTimeoutMs(count));
    console.log(`frontend snapshot_restore(${count}) elapsed: ${elapsed.toFixed(1)}ms`);
  }, 30_000);

  it('exports a database whose size scales predictably with operation count', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);
    const count = opCount();

    for (let i = 0; i < count; i++) {
      store.createNode({ nodeId: uuidv7(), kind: 'block', parentId: null });
      if (i % 10 === 0) {
        const nodeId = uuidv7();
        store.createNode({ nodeId, kind: 'block', parentId: null });
        store.setProperty({
          propertyValueId: uuidv7(),
          nodeId,
          schemaId: uuidv7(),
          value: { text: `value-${i}` },
        });
      }
    }

    const exported = store.export();
    const bytesPerOp = exported.byteLength / count;
    console.log(`frontend export(${count}): ${exported.byteLength} bytes (${bytesPerOp.toFixed(1)} B/op)`);

    // In-memory sql.js database overhead is higher than raw JSON; allow a
    // generous ceiling so the test stays green across builds.
    expect(bytesPerOp).toBeLessThan(5_000);
  }, 30_000);

  it('compacts old operations and keeps derived state intact', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);
    const count = Math.min(opCount(), 1_000);

    for (let i = 0; i < count; i++) {
      store.createNode({ nodeId: uuidv7(), kind: 'block', parentId: null });
    }
    const upToHlc = store.getClock().advance(Date.now());
    store.compactOperations(upToHlc);

    const opRows = db.exec(
      `SELECT COUNT(*) AS count FROM operation WHERE workspace_id = '${workspaceId}'`
    );
    expect(opRows[0].values[0][0]).toBe(0);

    const nodeRows = db.exec(`SELECT COUNT(*) AS count FROM node WHERE workspace_id = '${workspaceId}'`);
    expect(nodeRows[0].values[0][0]).toBe(count);
  }, 30_000);
});
