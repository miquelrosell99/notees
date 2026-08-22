/**
 * Local-first split (Task 3): the client-side workspace seed must emit the
 * same operation sequence as the server seed (`app/core/seed.py`,
 * `seed_workspace_relay`) and be idempotent across workspace opens.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../store';
import { createWorkspaceStoreClient } from '../worker/WorkspaceStoreClient';
import type { IWorkspaceStoreClient } from '../worker/workerProtocol';
import { queryAll } from '../db/sqlite';
import { listClasses } from '../query/classes';
import { uuidv7 } from '../uuid';
import { createTestDatabase } from './helpers';
import { buildWorkspaceSeedOperations, ensureLocalWorkspace } from '../seed';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';

const CLASS_COUNT = Object.keys(SYSTEM_CLASS_UUIDS).length;
/** class.create + node.updateContent per class, node.create per page. */
const SEED_OP_COUNT = CLASS_COUNT * 2 + 2;

function paragraphAst(text: string) {
  return [{ type: 'paragraph', children: [{ type: 'text', text }] }];
}

interface OpRow {
  op_type: string;
  payload: string;
  actor_id: string;
  workspace_id: string;
}

async function createSeededClient(userDisplayName = 'Test User') {
  const db = await createTestDatabase();
  const workspaceId = uuidv7();
  const actorId = uuidv7();
  const store = new WorkspaceStore(db, workspaceId, actorId);
  const client: IWorkspaceStoreClient = createWorkspaceStoreClient();
  await client.init(workspaceId, actorId, { store });
  const emitted = await ensureLocalWorkspace(client, actorId, userDisplayName);
  return { db, workspaceId, actorId, store, client, emitted };
}

function readOperationLog(db: Awaited<ReturnType<typeof createTestDatabase>>): OpRow[] {
  return queryAll<OpRow>(
    db,
    'SELECT op_type, payload, actor_id, workspace_id FROM operation ORDER BY rowid'
  );
}

describe('workspace seed (local mode)', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('builds the exact op sequence the server seed produces', () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const ops = buildWorkspaceSeedOperations(workspaceId, actorId, 'Test User');

    expect(ops).toHaveLength(SEED_OP_COUNT);

    let i = 0;
    for (const [name, classId] of Object.entries(SYSTEM_CLASS_UUIDS)) {
      const create = ops[i];
      expect(create.envelope.opType).toBe('class.create');
      expect(create.payload).toEqual({ classId, name });
      expect(create.envelope.affectedNodeIds).toEqual([classId]);

      const content = ops[i + 1];
      expect(content.envelope.opType).toBe('node.updateContent');
      expect(content.payload).toEqual({ nodeId: classId, content: paragraphAst(name) });
      expect(content.envelope.affectedNodeIds).toEqual([classId]);
      i += 2;
    }

    const inbox = ops[i];
    expect(inbox.envelope.opType).toBe('node.create');
    expect(inbox.payload).toEqual({
      nodeId: SYSTEM_PAGE_UUIDS.inbox,
      kind: 'page',
      initialContent: paragraphAst('Inbox'),
    });

    const userPage = ops[i + 1];
    expect(userPage.envelope.opType).toBe('node.create');
    expect(userPage.payload).toEqual({
      nodeId: SYSTEM_PAGE_UUIDS.scratchpad,
      kind: 'page',
      initialContent: paragraphAst('Test User'),
    });

    for (const op of ops) {
      expect(op.envelope.workspaceId).toBe(workspaceId);
      expect(op.envelope.actorId).toBe(actorId);
    }
  });

  it('emits the full seed sequence into an empty store and derives the expected state', async () => {
    const { db, store, emitted } = await createSeededClient();

    expect(emitted).toBe(SEED_OP_COUNT);

    const ops = readOperationLog(db);
    expect(ops).toHaveLength(SEED_OP_COUNT);
    expect(ops.slice(0, 2).map((op) => op.op_type)).toEqual(['class.create', 'node.updateContent']);
    expect(ops.slice(-2).map((op) => op.op_type)).toEqual(['node.create', 'node.create']);

    // All system classes exist with their names.
    const classes = listClasses(db, store.getWorkspaceId());
    expect(classes).toHaveLength(CLASS_COUNT);
    expect(classes.map((c) => c.id).sort()).toEqual(Object.values(SYSTEM_CLASS_UUIDS).sort());

    // Inbox page exists with its name as content.
    const inbox = store.getNode(SYSTEM_PAGE_UUIDS.inbox);
    expect(inbox?.kind).toBe('page');
    expect(inbox?.parentId ?? null).toBeNull();
    expect(JSON.parse(inbox!.content)).toEqual(paragraphAst('Inbox'));

    // The user's personal page carries the session's display name.
    const userPage = store.getNode(SYSTEM_PAGE_UUIDS.scratchpad);
    expect(JSON.parse(userPage!.content)).toEqual(paragraphAst('Test User'));
  });

  it('is idempotent: a second run emits nothing', async () => {
    const { db, client, actorId } = await createSeededClient();

    const second = await ensureLocalWorkspace(client, actorId, 'Test User');
    expect(second).toBe(0);
    expect(readOperationLog(db)).toHaveLength(SEED_OP_COUNT);
  });

  it('only emits ops for missing entries (server-seeded workspace opened locally)', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);
    const client = createWorkspaceStoreClient();
    await client.init(workspaceId, actorId, { store });

    // Simulate a workspace that already has everything except the Inbox page
    // (e.g. previously seeded by the server, or partially seeded).
    const allClasses = new Set(Object.values(SYSTEM_CLASS_UUIDS));
    const preExisting = buildWorkspaceSeedOperations(workspaceId, actorId, 'Test User', {
      classIds: allClasses,
      pageIds: new Set([SYSTEM_PAGE_UUIDS.scratchpad]),
    });
    await client.mutate('applyMany', [preExisting]);

    const emitted = await ensureLocalWorkspace(client, actorId, 'Test User');
    expect(emitted).toBe(1);

    const ops = readOperationLog(db);
    expect(ops).toHaveLength(SEED_OP_COUNT);
    const inboxCreates = ops.filter(
      (op) =>
        op.op_type === 'node.create' &&
        (JSON.parse(op.payload) as { nodeId: string }).nodeId === SYSTEM_PAGE_UUIDS.inbox
    );
    expect(inboxCreates).toHaveLength(1);
    expect(store.getNode(SYSTEM_PAGE_UUIDS.inbox)?.kind).toBe('page');
  });
});
