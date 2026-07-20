import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createOperation } from '../../types/operation';
import type { Database } from 'sql.js';
import { applyAssetOperation } from '../asset';
import { applyTaskOperation } from '../task';
import { applyActivityOperation } from '../activity';
import { applyLinkOperation } from '../link';
import { applyShareOperation } from '../share';
import { applyPluginOperation } from '../plugin';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { queryAll, queryOne } from '../../db/sqlite';
import { TextCrdt } from '../../crdt/text';
import { createDatabase } from '../../db/connection';

function makeOp(
  opType: string,
  payload: Record<string, unknown>,
  overrides?: {
    workspaceId?: string;
    actorId?: string;
    hlc?: { physical: number; logical: number };
    affectedNodeIds?: string[];
  }
) {
  return createOperation(
    {
      workspaceId: overrides?.workspaceId ?? uuidv7(),
      actorId: overrides?.actorId ?? uuidv7(),
      hlc: overrides?.hlc ?? { physical: Date.now(), logical: 0 },
      affectedNodeIds: overrides?.affectedNodeIds ?? (payload.nodeId ? [payload.nodeId as string] : []),
      opType,
    },
    payload
  );
}

async function createStore(): Promise<{ db: Database; store: WorkspaceStore; workspaceId: string; actorId: string }> {
  const db = await createTestDatabase();
  const workspaceId = uuidv7();
  const actorId = uuidv7();
  const store = new WorkspaceStore(db, workspaceId, actorId);
  return { db, store, workspaceId, actorId };
}

describe('asset applier', () => {
  it('records an asset upload', async () => {
    const { db } = await createStore();
    const nodeId = uuidv7();
    const op = makeOp('asset.upload', {
      nodeId,
      assetHash: 'sha256:abc',
      mimeType: 'image/png',
      size: 1234,
      originalName: 'diagram.png',
    });

    applyAssetOperation(db, op);

    const row = queryOne<{ node_id: string; asset_hash: string; mime_type: string; size: number; original_name: string }>(
      db,
      'SELECT node_id, asset_hash, mime_type, size, original_name FROM node_asset WHERE node_id = ?',
      [nodeId]
    );
    expect(row).toBeDefined();
    expect(row?.asset_hash).toBe('sha256:abc');
    expect(row?.mime_type).toBe('image/png');
    expect(row?.size).toBe(1234);
    expect(row?.original_name).toBe('diagram.png');
  });

  it('deletes a specific asset mapping', async () => {
    const { db } = await createStore();
    const nodeId = uuidv7();
    applyAssetOperation(
      db,
      makeOp('asset.upload', {
        nodeId,
        assetHash: 'sha256:abc',
        mimeType: 'image/png',
        size: 1,
        originalName: 'a.png',
      })
    );

    applyAssetOperation(db, makeOp('asset.delete', { nodeId, assetHash: 'sha256:abc' }));

    const row = queryOne<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM node_asset WHERE node_id = ?',
      [nodeId]
    );
    expect(row?.count).toBe(0);
  });

  it('deletes all asset mappings for a node when no hash is given', async () => {
    const { db } = await createStore();
    const nodeId = uuidv7();
    applyAssetOperation(
      db,
      makeOp('asset.upload', {
        nodeId,
        assetHash: 'sha256:one',
        mimeType: 'image/png',
        size: 1,
        originalName: 'a.png',
      })
    );
    applyAssetOperation(
      db,
      makeOp('asset.upload', {
        nodeId,
        assetHash: 'sha256:two',
        mimeType: 'image/png',
        size: 2,
        originalName: 'b.png',
      })
    );

    applyAssetOperation(db, makeOp('asset.delete', { nodeId }));

    const row = queryOne<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM node_asset WHERE node_id = ?',
      [nodeId]
    );
    expect(row?.count).toBe(0);
  });

  it('cleans up asset mappings on node.delete', async () => {
    const { store } = await createStore();
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.apply(
      makeOp('asset.upload', {
        nodeId,
        assetHash: 'sha256:abc',
        mimeType: 'image/png',
        size: 1,
        originalName: 'a.png',
      })
    );

    store.deleteNode(nodeId);

    const row = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM node_asset WHERE node_id = ?',
      [nodeId]
    );
    expect(row?.count).toBe(0);
  });
});

describe('task applier', () => {
  it('records a completion', async () => {
    const { db } = await createStore();
    const nodeId = uuidv7();
    const completionId = uuidv7();
    applyTaskOperation(
      db,
      makeOp('task.recordCompletion', { nodeId, completionId, completedAt: '2026-07-18T10:00:00.000Z' })
    );

    const row = queryOne<{ id: string; node_id: string; completed_at: string }>(
      db,
      'SELECT id, node_id, completed_at FROM task_completion WHERE node_id = ?',
      [nodeId]
    );
    expect(row?.id).toBe(completionId);
    expect(row?.completed_at).toBe('2026-07-18T10:00:00.000Z');
  });

  it('deletes a completion', async () => {
    const { db } = await createStore();
    const nodeId = uuidv7();
    const completionId = uuidv7();
    applyTaskOperation(db, makeOp('task.recordCompletion', { nodeId, completionId }));
    applyTaskOperation(db, makeOp('task.deleteCompletion', { nodeId, completionId }));

    const row = queryOne<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM task_completion WHERE node_id = ?',
      [nodeId]
    );
    expect(row?.count).toBe(0);
  });

  it('sets and replaces recurrence', async () => {
    const { db } = await createStore();
    const nodeId = uuidv7();
    const recurrenceId = uuidv7();
    applyTaskOperation(db, makeOp('task.setRecurrence', { nodeId, recurrenceId, rule: 'FREQ=DAILY' }));
    applyTaskOperation(db, makeOp('task.setRecurrence', { nodeId, recurrenceId, rule: 'FREQ=WEEKLY' }));

    const row = queryOne<{ rule: string }>(
      db,
      'SELECT rule FROM task_recurrence WHERE node_id = ?',
      [nodeId]
    );
    expect(row?.rule).toBe('FREQ=WEEKLY');
  });

  it('deletes recurrence', async () => {
    const { db } = await createStore();
    const nodeId = uuidv7();
    const recurrenceId = uuidv7();
    applyTaskOperation(db, makeOp('task.setRecurrence', { nodeId, recurrenceId, rule: 'FREQ=DAILY' }));
    applyTaskOperation(db, makeOp('task.deleteRecurrence', { nodeId, recurrenceId }));

    const row = queryOne<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM task_recurrence WHERE node_id = ?',
      [nodeId]
    );
    expect(row?.count).toBe(0);
  });

  it('cleans up task state on node.delete', async () => {
    const { store } = await createStore();
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.apply(makeOp('task.recordCompletion', { nodeId, completionId: uuidv7() }));
    store.apply(makeOp('task.setRecurrence', { nodeId, recurrenceId: uuidv7(), rule: 'FREQ=DAILY' }));

    store.deleteNode(nodeId);

    const completionCount = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM task_completion WHERE node_id = ?',
      [nodeId]
    );
    const recurrenceCount = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM task_recurrence WHERE node_id = ?',
      [nodeId]
    );
    expect(completionCount?.count).toBe(0);
    expect(recurrenceCount?.count).toBe(0);
  });
});

describe('activity applier', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('records an activity row', async () => {
    const { db, workspaceId, actorId } = await createStore();
    const op = makeOp(
      'activity.record',
      {
        nodeId: uuidv7(),
        activityType: 'node.viewed',
        metadata: { source: 'quick-search' },
      },
      { workspaceId, actorId }
    );

    applyActivityOperation(db, op);

    const row = queryOne<{ workspace_id: string; actor_id: string; op_type: string; metadata: string }>(
      db,
      'SELECT workspace_id, actor_id, op_type, metadata FROM activity_log WHERE id = ?',
      [op.envelope.id]
    );
    expect(row?.workspace_id).toBe(workspaceId);
    expect(row?.actor_id).toBe(actorId);
    expect(row?.op_type).toBe('node.viewed');
    expect(JSON.parse(row?.metadata ?? '{}')).toEqual({ source: 'quick-search' });
  });

  it('is idempotent', async () => {
    const { db } = await createStore();
    const op = makeOp('activity.record', { activityType: 'node.viewed' });
    applyActivityOperation(db, op);
    applyActivityOperation(db, op);

    const row = queryOne<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM activity_log WHERE id = ?',
      [op.envelope.id]
    );
    expect(row?.count).toBe(1);
  });

  it('cleans up activity rows on node.delete', async () => {
    const { store } = await createStore();
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    const op = makeOp('activity.record', { nodeId, activityType: 'node.viewed' });
    store.apply(op);

    store.deleteNode(nodeId);

    const row = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM activity_log WHERE node_id = ?',
      [nodeId]
    );
    expect(row?.count).toBe(0);
  });
});

describe('link applier', () => {
  it('increments click count', async () => {
    const { db } = await createStore();
    const nodeId = uuidv7();
    const targetId = uuidv7();
    const baseOp = makeOp('link.click', { nodeId, targetId });

    applyLinkOperation(db, baseOp);
    applyLinkOperation(db, baseOp);

    const row = queryOne<{ click_count: number; target_id: string }>(
      db,
      'SELECT click_count, target_id FROM link_click WHERE node_id = ? AND target_id = ?',
      [nodeId, targetId]
    );
    expect(row?.click_count).toBe(2);
    expect(row?.target_id).toBe(targetId);
  });

  it('cleans up link clicks on node.delete', async () => {
    const { store } = await createStore();
    const nodeId = uuidv7();
    const targetId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.apply(makeOp('link.click', { nodeId, targetId }));

    store.deleteNode(nodeId);

    const row = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM link_click WHERE node_id = ? OR target_id = ?',
      [nodeId, nodeId]
    );
    expect(row?.count).toBe(0);
  });
});

describe('share applier', () => {
  it('creates and revokes a public share', async () => {
    const { db } = await createStore();
    const nodeId = uuidv7();
    applyShareOperation(
      db,
      makeOp('share.public.create', { nodeId, slug: 'my-share', passwordHash: 'hash' })
    );

    const row = queryOne<{ slug: string; password_hash: string }>(
      db,
      'SELECT slug, password_hash FROM node_public_share WHERE node_id = ?',
      [nodeId]
    );
    expect(row?.slug).toBe('my-share');
    expect(row?.password_hash).toBe('hash');

    applyShareOperation(db, makeOp('share.public.revoke', { nodeId }));
    const countRow = queryOne<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM node_public_share WHERE node_id = ?',
      [nodeId]
    );
    expect(countRow?.count).toBe(0);
  });

  it('grants and revokes a user share', async () => {
    const { db, actorId } = await createStore();
    const nodeId = uuidv7();
    const userId = uuidv7();
    applyShareOperation(
      db,
      makeOp('share.user.grant', { nodeId, userId, role: 'editor' }, { actorId })
    );

    const row = queryOne<{ user_id: string; role: string; created_by: string }>(
      db,
      'SELECT user_id, role, created_by FROM node_user_share WHERE node_id = ? AND user_id = ?',
      [nodeId, userId]
    );
    expect(row?.role).toBe('editor');
    expect(row?.created_by).toBe(actorId);

    applyShareOperation(db, makeOp('share.user.revoke', { nodeId, userId }));
    const countRow = queryOne<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM node_user_share WHERE node_id = ?',
      [nodeId]
    );
    expect(countRow?.count).toBe(0);
  });

  it('is idempotent for grants', async () => {
    const { db } = await createStore();
    const nodeId = uuidv7();
    const userId = uuidv7();
    const op = makeOp('share.user.grant', { nodeId, userId, role: 'viewer' });
    applyShareOperation(db, op);
    applyShareOperation(db, op);

    const rows = queryAll<{ role: string }>(
      db,
      'SELECT role FROM node_user_share WHERE node_id = ? AND user_id = ?',
      [nodeId, userId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('viewer');
  });

  it('cleans up share rows on node.delete', async () => {
    const { store } = await createStore();
    const nodeId = uuidv7();
    const userId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.apply(makeOp('share.public.create', { nodeId, slug: 'share' }));
    store.apply(makeOp('share.user.grant', { nodeId, userId, role: 'viewer' }));

    store.deleteNode(nodeId);

    const publicCount = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM node_public_share WHERE node_id = ?',
      [nodeId]
    );
    const userCount = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM node_user_share WHERE node_id = ?',
      [nodeId]
    );
    expect(publicCount?.count).toBe(0);
    expect(userCount?.count).toBe(0);
  });
});

describe('plugin applier', () => {
  it('records a plugin operation', async () => {
    const { db, workspaceId, actorId } = await createStore();
    const op = makeOp(
      'plugin.op',
      {
        pluginId: 'plugin/calendar',
        opType: 'event.create',
        data: { title: 'Standup' },
      },
      { workspaceId, actorId }
    );

    applyPluginOperation(db, op);

    const row = queryOne<{ workspace_id: string; actor_id: string; plugin_id: string; op_type: string; data: string }>(
      db,
      'SELECT workspace_id, actor_id, plugin_id, op_type, data FROM plugin_op_log WHERE id = ?',
      [op.envelope.id]
    );
    expect(row?.workspace_id).toBe(workspaceId);
    expect(row?.actor_id).toBe(actorId);
    expect(row?.plugin_id).toBe('plugin/calendar');
    expect(row?.op_type).toBe('event.create');
    expect(JSON.parse(row?.data ?? '{}')).toEqual({ title: 'Standup' });
  });

  it('is idempotent', async () => {
    const { db } = await createStore();
    const op = makeOp('plugin.op', { pluginId: 'plugin/calendar', opType: 'noop', data: {} });
    applyPluginOperation(db, op);
    applyPluginOperation(db, op);

    const row = queryOne<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM plugin_op_log WHERE id = ?',
      [op.envelope.id]
    );
    expect(row?.count).toBe(1);
  });
});

describe('version applier', () => {
  it('records a version snapshot on node.updateContent', async () => {
    const { store } = await createStore();
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.updateText(nodeId, (text) => text.insert(0, 'First draft'));
    store.updateText(nodeId, (text) => text.insert(0, 'Second draft - '));

    const versions = store.getNodeVersions(nodeId);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[0].name).toContain('Second draft');
    expect(versions[1].name).toContain('First draft');
  });

  it('restores a previous version', async () => {
    const { store } = await createStore();
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.updateText(nodeId, (text) => text.insert(0, 'Original'));
    store.updateText(nodeId, (text) => text.insert(0, 'Updated - '));

    const versions = store.getNodeVersions(nodeId);
    const originalVersion = versions[versions.length - 1];
    store.restoreNodeVersion(nodeId, originalVersion.uuid);

    const node = store.getNode(nodeId);
    expect(node?.content).toContain('Original');
  });

  it('cleans up version rows on node.delete', async () => {
    const { store } = await createStore();
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });
    store.updateText(nodeId, (text) => text.insert(0, 'Content'));

    store.deleteNode(nodeId);

    const row = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM node_version WHERE node_id = ?',
      [nodeId]
    );
    expect(row?.count).toBe(0);
  });
});

describe('merge pages', () => {
  it('moves children and archives source', async () => {
    const { store } = await createStore();
    const sourceId = uuidv7();
    const targetId = uuidv7();
    const childId = uuidv7();

    store.createNode({ nodeId: sourceId, kind: 'page', parentId: null });
    store.createNode({ nodeId: targetId, kind: 'page', parentId: null });
    store.createNode({ nodeId: childId, kind: 'block', parentId: null });
    store.moveNode(childId, sourceId);

    store.mergePages(sourceId, targetId);

    expect(store.getChildren(targetId)).toContain(childId);
    expect(store.getChildren(sourceId)).toHaveLength(0);
    const source = store.getNode(sourceId);
    expect(source?.active).toBe(false);
  });

  it('rewrites backlinks from source to target', async () => {
    const { store } = await createStore();
    const sourceId = uuidv7();
    const targetId = uuidv7();
    const referrerId = uuidv7();

    store.createNode({ nodeId: sourceId, kind: 'page', parentId: null });
    store.createNode({ nodeId: targetId, kind: 'page', parentId: null });
    store.createNode({ nodeId: referrerId, kind: 'page', parentId: null });
    store.updateContentAst(referrerId, [
      { type: 'text', text: 'See ' },
      { type: 'ref', targetId: sourceId },
    ]);

    store.mergePages(sourceId, targetId);

    const referrer = store.getNode(referrerId);
    expect(referrer?.content).toContain(targetId);
    expect(referrer?.content).not.toContain(sourceId);
  });
});

describe('alias applier', () => {
  it('records an alias relationship', async () => {
    const { store } = await createStore();
    const canonicalId = uuidv7();
    const aliasId = uuidv7();
    store.createNode({ nodeId: canonicalId, kind: 'page', parentId: null });
    store.createNode({ nodeId: aliasId, kind: 'page', parentId: null });

    store.addAlias(canonicalId, aliasId);

    const row = queryOne<{ canonical_node_id: string }>(
      store.getDb(),
      'SELECT canonical_node_id FROM node_alias WHERE alias_node_id = ?',
      [aliasId]
    );
    expect(row?.canonical_node_id).toBe(canonicalId);
  });

  it('removes an alias relationship', async () => {
    const { store } = await createStore();
    const canonicalId = uuidv7();
    const aliasId = uuidv7();
    store.createNode({ nodeId: canonicalId, kind: 'page', parentId: null });
    store.createNode({ nodeId: aliasId, kind: 'page', parentId: null });
    store.addAlias(canonicalId, aliasId);

    store.removeAlias(canonicalId, aliasId);

    const row = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM node_alias WHERE alias_node_id = ?',
      [aliasId]
    );
    expect(row?.count).toBe(0);
  });

  it('cleans up alias rows when the alias node is deleted', async () => {
    const { store } = await createStore();
    const canonicalId = uuidv7();
    const aliasId = uuidv7();
    store.createNode({ nodeId: canonicalId, kind: 'page', parentId: null });
    store.createNode({ nodeId: aliasId, kind: 'page', parentId: null });
    store.addAlias(canonicalId, aliasId);

    store.deleteNode(aliasId);

    const row = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM node_alias WHERE alias_node_id = ? OR canonical_node_id = ?',
      [aliasId, aliasId]
    );
    expect(row?.count).toBe(0);
  });

  it('cleans up alias rows when the canonical node is deleted', async () => {
    const { store } = await createStore();
    const canonicalId = uuidv7();
    const aliasId = uuidv7();
    store.createNode({ nodeId: canonicalId, kind: 'page', parentId: null });
    store.createNode({ nodeId: aliasId, kind: 'page', parentId: null });
    store.addAlias(canonicalId, aliasId);

    store.deleteNode(canonicalId);

    const row = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM node_alias WHERE alias_node_id = ? OR canonical_node_id = ?',
      [canonicalId, canonicalId]
    );
    expect(row?.count).toBe(0);
  });

});


describe('property schema applier', () => {
  it('creates a property schema', async () => {
    const { store } = await createStore();
    store.apply(
      makeOp('propertySchema.create', {
        schemaId: 's-1',
        name: 'Status',
        type: 'selection',
        scope: 'global',
        options: [{ uuid: 'opt-1', name: 'Done', sequence: 0 }],
      })
    );

    const row = queryOne<{ name: string; type: string; options: string }>(
      store.getDb(),
      'SELECT name, type, options FROM property_schema WHERE id = ?',
      ['s-1']
    );
    expect(row?.name).toBe('Status');
    expect(row?.type).toBe('selection');
    expect(JSON.parse(row?.options ?? '[]')).toEqual([{ uuid: 'opt-1', name: 'Done', sequence: 0 }]);
  });

  it('updates a property schema', async () => {
    const { store } = await createStore();
    store.apply(makeOp('propertySchema.create', { schemaId: 's-1', name: 'Old' }));
    store.apply(makeOp('propertySchema.update', { schemaId: 's-1', name: 'New', required: true }, { hlc: { physical: Date.now() + 1, logical: 0 } }));

    const row = queryOne<{ name: string; required: number }>(
      store.getDb(),
      'SELECT name, required FROM property_schema WHERE id = ?',
      ['s-1']
    );
    expect(row?.name).toBe('New');
    expect(row?.required).toBe(1);
  });

  it('soft-deletes a property schema', async () => {
    const { store } = await createStore();
    store.apply(makeOp('propertySchema.create', { schemaId: 's-1', name: 'ToDelete' }));
    store.apply(makeOp('propertySchema.delete', { schemaId: 's-1' }, { hlc: { physical: Date.now() + 1, logical: 0 } }));

    const row = queryOne<{ active: number }>(
      store.getDb(),
      'SELECT active FROM property_schema WHERE id = ?',
      ['s-1']
    );
    expect(row?.active).toBe(0);
  });

  it('is idempotent by operation id', async () => {
    const { store } = await createStore();
    const op = makeOp('propertySchema.create', { schemaId: 's-1', name: 'One' });
    store.apply(op);
    store.apply(op);

    const row = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM property_schema WHERE id = ?',
      ['s-1']
    );
    expect(row?.count).toBe(1);
  });
});

describe('class property edge applier', () => {
  it('creates an edge', async () => {
    const { store } = await createStore();
    store.apply(makeOp('classPropertyEdge.create', { classId: 'c-1', propertySchemaId: 's-1', sequence: 0, required: true }));

    const row = queryOne<{ sequence: number; required: number | null }>(
      store.getDb(),
      'SELECT sequence, required FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?',
      ['c-1', 's-1']
    );
    expect(row?.sequence).toBe(0);
    expect(row?.required).toBe(1);
  });

  it('updates an edge', async () => {
    const { store } = await createStore();
    store.apply(makeOp('classPropertyEdge.create', { classId: 'c-1', propertySchemaId: 's-1' }));
    store.apply(
      makeOp(
        'classPropertyEdge.update',
        { classId: 'c-1', propertySchemaId: 's-1', sequence: 3, required: false },
        { hlc: { physical: Date.now() + 1, logical: 0 } }
      )
    );

    const row = queryOne<{ sequence: number; required: number | null }>(
      store.getDb(),
      'SELECT sequence, required FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?',
      ['c-1', 's-1']
    );
    expect(row?.sequence).toBe(3);
    expect(row?.required).toBe(0);
  });

  it('deletes an edge', async () => {
    const { store } = await createStore();
    store.apply(makeOp('classPropertyEdge.create', { classId: 'c-1', propertySchemaId: 's-1' }));
    store.apply(makeOp('classPropertyEdge.delete', { classId: 'c-1', propertySchemaId: 's-1' }, { hlc: { physical: Date.now() + 1, logical: 0 } }));

    const row = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?',
      ['c-1', 's-1']
    );
    expect(row?.count).toBe(0);
  });

  it('reorders edges', async () => {
    const { store } = await createStore();
    store.apply(makeOp('classPropertyEdge.create', { classId: 'c-1', propertySchemaId: 's-1', sequence: 0 }));
    store.apply(makeOp('classPropertyEdge.create', { classId: 'c-1', propertySchemaId: 's-2', sequence: 1 }));
    store.apply(
      makeOp(
        'classPropertyEdge.reorder',
        { classId: 'c-1', orderedPropertySchemaIds: ['s-2', 's-1'] },
        { hlc: { physical: Date.now() + 1, logical: 0 } }
      )
    );

    const rows = queryAll<{ property_schema_id: string; sequence: number }>(
      store.getDb(),
      'SELECT property_schema_id, sequence FROM class_property_edge WHERE class_id = ? ORDER BY sequence',
      ['c-1']
    );
    expect(rows.map((r) => [r.property_schema_id, r.sequence])).toEqual([
      ['s-2', 0],
      ['s-1', 1],
    ]);
  });

  it('inherits properties through class hierarchy', async () => {
    const { store } = await createStore();
    // Parent class has property s-1.
    store.apply(makeOp('class.create', { classId: 'parent', extends: [] }));
    store.apply(makeOp('propertySchema.create', { schemaId: 's-1', name: 'Inherited' }));
    store.apply(makeOp('classPropertyEdge.create', { classId: 'parent', propertySchemaId: 's-1', sequence: 0 }));

    // Child class extends parent.
    store.apply(makeOp('class.create', { classId: 'child', extends: ['parent'] }, { hlc: { physical: Date.now() + 1, logical: 0 } }));

    const rows = queryAll<{ ancestor_id: string }>(
      store.getDb(),
      'SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?',
      ['child']
    );
    expect(rows.map((r) => r.ancestor_id)).toContain('parent');

    const directEdges = queryAll<{ property_schema_id: string }>(
      store.getDb(),
      'SELECT property_schema_id FROM class_property_edge WHERE class_id = ?',
      ['child']
    );
    expect(directEdges).toHaveLength(0);

    const inheritedEdges = queryAll<{ class_id: string; property_schema_id: string }>(
      store.getDb(),
      `SELECT e.class_id, e.property_schema_id
       FROM class_hierarchy h
       JOIN class_property_edge e ON e.class_id = h.ancestor_id
       WHERE h.class_id = ? AND h.ancestor_id != ?`,
      ['child', 'child']
    );
    expect(inheritedEdges).toHaveLength(1);
    expect(inheritedEdges[0].property_schema_id).toBe('s-1');
  });
});

describe('property schema cleanup on node permanent delete', () => {
  it('deletes schema rows bound to the node and edge rows owned by the node', async () => {
    const { store } = await createStore();
    store.createNode({ nodeId: 'n-1', kind: 'class', parentId: null });
    store.apply(makeOp('propertySchema.create', { schemaId: 's-1', name: 'Local', nodeId: 'n-1' }, { hlc: { physical: Date.now() + 1, logical: 0 } }));
    store.apply(makeOp('classPropertyEdge.create', { classId: 'n-1', propertySchemaId: 's-1' }, { hlc: { physical: Date.now() + 2, logical: 0 } }));

    store.permanentDeleteNode('n-1');

    const schemaCount = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM property_schema WHERE node_id = ?',
      ['n-1']
    );
    const edgeCount = queryOne<{ count: number }>(
      store.getDb(),
      'SELECT COUNT(*) AS count FROM class_property_edge WHERE class_id = ?',
      ['n-1']
    );
    expect(schemaCount?.count).toBe(0);
    expect(edgeCount?.count).toBe(0);
  });
});

describe('text CRDT formatting', () => {
  it('persists formatting attributes in crdt_state through node.updateContent', async () => {
    const { store } = await createStore();
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'block', parentId: null });

    store.updateText(nodeId, (text) => {
      text.insert(0, 'Hello world');
      text.format(0, 5, { bold: true });
    });

    const savedState = store.getTextState(nodeId);
    const reloaded = new TextCrdt(savedState);

    expect(reloaded.toPlaintext()).toBe('Hello world');
    const deltas = reloaded.toDelta();
    const boldDelta = deltas.find(
      (d) => (d.attributes as Record<string, unknown> | undefined)?.bold === true
    );
    expect(boldDelta).toBeDefined();
    expect(boldDelta?.insert).toBe('Hello');
  });

  it('keeps crdt_state and node content in sync across reload', async () => {
    const { store, actorId } = await createStore();
    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'block', parentId: null });

    store.updateText(nodeId, (text) => {
      text.insert(0, 'Persisted text');
      text.format(0, 9, { italic: true });
    });

    const contentBefore = store.getNode(nodeId)?.content;

    // Simulate store reload from exported bytes.
    const bytes = store.export();
    const freshDb = await createDatabase(bytes);
    const freshStore = new WorkspaceStore(
      freshDb,
      store.getWorkspaceId(),
      actorId
    );

    const stateAfter = freshStore.getTextState(nodeId);
    const contentAfter = freshStore.getNode(nodeId)?.content;

    expect(contentAfter).toBe(contentBefore);
    const reloaded = new TextCrdt(stateAfter);
    expect(reloaded.toPlaintext()).toBe('Persisted text');
    const deltas = reloaded.toDelta();
    const italicDelta = deltas.find(
      (d) => (d.attributes as Record<string, unknown> | undefined)?.italic === true
    );
    expect(italicDelta?.insert).toBe('Persisted');
  });
});
