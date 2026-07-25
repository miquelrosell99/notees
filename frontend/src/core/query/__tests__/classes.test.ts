/**
 * Unit tests for class table query helpers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { listClasses, getClass } from '../classes';

describe('class queries', () => {
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

  function insertClass(
    store: WorkspaceStore,
    id: string,
    name: string,
    extras?: { icon?: string; color?: string; description?: string; extendsClassIds?: string[]; active?: number }
  ): void {
    const db = store.getDb();
    db.run(
      `INSERT INTO class (
        id, workspace_id, name, icon, color, description, extends_class_ids, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        store.getWorkspaceId(),
        name,
        extras?.icon ?? null,
        extras?.color ?? null,
        extras?.description ?? null,
        JSON.stringify(extras?.extendsClassIds ?? []),
        extras?.active ?? 1,
        '2026-07-25T00:00:00.000Z',
        '2026-07-25T00:00:00.000Z',
      ]
    );
  }

  it('listClasses returns active classes ordered by name', async () => {
    const store = await makeStore();
    const otherWorkspace = uuidv7();
    store.getDb().run(
      `INSERT INTO class (
        id, workspace_id, name, icon, color, description, extends_class_ids, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'other-class',
        otherWorkspace,
        'Other',
        null,
        null,
        null,
        '[]',
        1,
        '2026-07-25T00:00:00.000Z',
        '2026-07-25T00:00:00.000Z',
      ]
    );

    insertClass(store, 'class-b', 'Beta');
    insertClass(store, 'class-a', 'Alpha');
    insertClass(store, 'class-inactive', 'Inactive', { active: 0 });

    const results = listClasses(store.getDb(), store.getWorkspaceId());
    expect(results.map((c) => c.id)).toEqual(['class-a', 'class-b']);
    expect(results[0].name).toBe('Alpha');
    expect(results[0].active).toBe(true);
  });

  it('getClass returns a class by id', async () => {
    const store = await makeStore();
    insertClass(store, 'class-1', 'Project', {
      icon: 'folder',
      color: '#ff0000',
      description: 'A project class',
      extendsClassIds: ['parent-1'],
    });

    const row = getClass(store.getDb(), 'class-1');
    expect(row).toBeDefined();
    expect(row?.id).toBe('class-1');
    expect(row?.name).toBe('Project');
    expect(row?.icon).toBe('folder');
    expect(row?.color).toBe('#ff0000');
    expect(row?.description).toBe('A project class');
    expect(row?.extendsClassIds).toEqual(['parent-1']);
    expect(row?.active).toBe(true);
  });

  it('getClass returns undefined for unknown ids', async () => {
    const store = await makeStore();
    const row = getClass(store.getDb(), 'missing');
    expect(row).toBeUndefined();
  });

  it('parses extends_class_ids JSON', async () => {
    const store = await makeStore();
    insertClass(store, 'class-1', 'Child', { extendsClassIds: ['a', 'b'] });

    const row = getClass(store.getDb(), 'class-1');
    expect(row?.extendsClassIds).toEqual(['a', 'b']);
  });
});
