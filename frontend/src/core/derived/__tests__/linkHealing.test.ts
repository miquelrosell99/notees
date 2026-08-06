import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { type Database } from 'sql.js';
import { createTestDatabase } from '../../__tests__/helpers';
import { healNodeLinkTarget } from '../linkHealing';
import { WorkspaceStore } from '../../store';
import { queryOne } from '../../db/sqlite';
import { uuidv7 } from '../../uuid';
import { buildLinkId } from '@/lib/astBuilder';

beforeAll(() => {
  if (typeof globalThis.crypto === 'undefined') {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
  }
});

function insertNode(db: Database, nodeId: string, content: unknown[]) {
  db.run(
    'INSERT INTO node (id, workspace_id, kind, class_ids, parent_id, content, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [nodeId, uuidv7(), 'block', '[]', null, JSON.stringify(content), 1, new Date().toISOString(), new Date().toISOString()]
  );
}

function insertNodeLink(db: Database, linkUuid: string, sourceId: string, targetId: string) {
  db.run(
    'INSERT INTO node_link (id, workspace_id, source_id, target_id, type, label, click_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [linkUuid, uuidv7(), sourceId, targetId, 'node', null, 0, new Date().toISOString(), new Date().toISOString()]
  );
}

describe('linkHealing', () => {
  it('returns the canonical target when AST target differs from node_link', async () => {
    const db = await createTestDatabase();
    const sourceId = uuidv7();
    const astTarget = uuidv7();
    const canonicalTarget = uuidv7();
    const linkUuid = uuidv7();
    const linkId = buildLinkId(astTarget, linkUuid);

    insertNode(db, sourceId, [
      { type: 'paragraph', children: [{ type: 'node_link', link_id: linkId, ref_type: 'node' }] },
    ]);
    insertNodeLink(db, linkUuid, sourceId, canonicalTarget);

    const result = healNodeLinkTarget(db, sourceId, linkId);

    expect(result.canonicalTargetUuid).toBe(canonicalTarget);
    expect(result.healed).toBe(false);
  });

  it('heals the AST when requested', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);
    const sourceId = uuidv7();
    const astTarget = uuidv7();
    const canonicalTarget = uuidv7();
    const linkUuid = uuidv7();
    const linkId = buildLinkId(astTarget, linkUuid);

    insertNode(db, sourceId, [
      { type: 'paragraph', children: [{ type: 'node_link', link_id: linkId, ref_type: 'node' }] },
    ]);
    insertNodeLink(db, linkUuid, sourceId, canonicalTarget);

    const resolved = store.resolveAndHealNodeLink(sourceId, linkId);

    expect(resolved).toBe(canonicalTarget);
    const row = queryOne<{ content: string }>(db, 'SELECT content FROM node WHERE id = ?', [sourceId]);
    expect(row).toBeDefined();
    const content = JSON.parse(row!.content) as Array<{ children?: Array<{ link_id?: string }> }>;
    expect(content[0]?.children?.[0]?.link_id).toBe(buildLinkId(canonicalTarget, linkUuid));
  });

  it('does not heal when AST target matches node_link', async () => {
    const db = await createTestDatabase();
    const sourceId = uuidv7();
    const targetId = uuidv7();
    const linkUuid = uuidv7();
    const linkId = buildLinkId(targetId, linkUuid);

    insertNode(db, sourceId, [
      { type: 'paragraph', children: [{ type: 'node_link', link_id: linkId, ref_type: 'node' }] },
    ]);
    insertNodeLink(db, linkUuid, sourceId, targetId);

    const result = healNodeLinkTarget(db, sourceId, linkId, { heal: true });

    expect(result.canonicalTargetUuid).toBe(targetId);
    expect(result.healed).toBe(false);
  });
});
