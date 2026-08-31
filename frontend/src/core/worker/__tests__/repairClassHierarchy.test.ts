/**
 * Unit tests for repairClassHierarchy startup repair.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { repairClassHierarchy } from '../queryHelpers';
import { queryAll } from '../../db/sqlite';

describe('repairClassHierarchy', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  async function makeStore() {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    return new WorkspaceStore(db, workspaceId, actorId);
  }

  function hierarchyRows(store: WorkspaceStore): Array<{ class_id: string; ancestor_id: string }> {
    return queryAll(
      store.getDb(),
      'SELECT class_id, ancestor_id FROM class_hierarchy ORDER BY class_id, ancestor_id'
    );
  }

  function insertClass(store: WorkspaceStore, id: string, extendsIds: string[]): void {
    store.getDb().run(
      `INSERT INTO class (id, workspace_id, name, icon, color, description, extends_class_ids, active, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, 1, '', '')`,
      [id, store.getWorkspaceId(), id, JSON.stringify(extendsIds)]
    );
  }

  it('rebuilds the closure from the class table, including transitive ancestors and self rows', async () => {
    const store = await makeStore();
    // agent extends entity; task extends agent → task ancestors: agent, entity
    insertClass(store, 'entity', []);
    insertClass(store, 'agent', ['entity']);
    insertClass(store, 'task', ['agent']);

    repairClassHierarchy(store);

    expect(hierarchyRows(store)).toEqual([
      { class_id: 'agent', ancestor_id: 'agent' },
      { class_id: 'agent', ancestor_id: 'entity' },
      { class_id: 'entity', ancestor_id: 'entity' },
      { class_id: 'task', ancestor_id: 'agent' },
      { class_id: 'task', ancestor_id: 'entity' },
      { class_id: 'task', ancestor_id: 'task' },
    ]);
  });

  it('heals a stale closure left by an older applier', async () => {
    const store = await makeStore();
    insertClass(store, 'entity', []);
    insertClass(store, 'agent', ['entity']);
    // Stale: agent's closure is missing its entity ancestor (and even its self row)
    store.getDb().run(
      "INSERT INTO class_hierarchy (class_id, ancestor_id) VALUES ('entity', 'entity')"
    );

    repairClassHierarchy(store);

    expect(hierarchyRows(store)).toEqual([
      { class_id: 'agent', ancestor_id: 'agent' },
      { class_id: 'agent', ancestor_id: 'entity' },
      { class_id: 'entity', ancestor_id: 'entity' },
    ]);
  });

  it('is cycle-safe and idempotent', async () => {
    const store = await makeStore();
    // Corrupt data with a cycle a ↔ b
    insertClass(store, 'a', ['b']);
    insertClass(store, 'b', ['a']);

    repairClassHierarchy(store);
    const first = hierarchyRows(store);
    repairClassHierarchy(store);
    expect(hierarchyRows(store)).toEqual(first);
    expect(first).toContainEqual({ class_id: 'a', ancestor_id: 'b' });
    expect(first).toContainEqual({ class_id: 'b', ancestor_id: 'a' });
  });

  it('is a no-op when there are no classes', async () => {
    const store = await makeStore();
    repairClassHierarchy(store);
    expect(hierarchyRows(store)).toEqual([]);
  });
});
