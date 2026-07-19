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
