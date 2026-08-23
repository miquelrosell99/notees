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
import {
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PAGE_UUIDS,
  SYSTEM_PROPERTY_SCHEMA_SPECS,
  SYSTEM_PROPERTY_UUIDS,
} from '@/constants/systemProperties';

const CLASS_COUNT = Object.keys(SYSTEM_CLASS_UUIDS).length;
const SCHEMA_COUNT = Object.keys(SYSTEM_PROPERTY_SCHEMA_SPECS).length;
/**
 * class.create + node.updateContent per class, propertySchema.create +
 * classPropertyEdge.create per schema, node.create per page.
 */
const SEED_OP_COUNT = CLASS_COUNT * 2 + SCHEMA_COUNT * 2 + 2;

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
      const expectedPayload: Record<string, unknown> = { classId, name };
      const icon = SYSTEM_CLASS_ICONS[name];
      if (icon) expectedPayload.icon = icon;
      const extendsNames = SYSTEM_CLASS_EXTENDS[name] ?? [];
      if (extendsNames.length > 0) {
        expectedPayload.extends = extendsNames.map(
          (parent) => SYSTEM_CLASS_UUIDS[parent as keyof typeof SYSTEM_CLASS_UUIDS]
        );
      }
      expect(create.payload).toEqual(expectedPayload);
      expect(create.envelope.affectedNodeIds).toEqual([classId]);

      const content = ops[i + 1];
      expect(content.envelope.opType).toBe('node.updateContent');
      expect(content.payload).toEqual({ nodeId: classId, content: paragraphAst(name) });
      expect(content.envelope.affectedNodeIds).toEqual([classId]);
      i += 2;
    }

    const edgeSequencePerClass = new Map<string, number>();
    for (const [schemaName, spec] of Object.entries(SYSTEM_PROPERTY_SCHEMA_SPECS)) {
      const schemaId = SYSTEM_PROPERTY_UUIDS[schemaName as keyof typeof SYSTEM_PROPERTY_UUIDS];
      const classId = SYSTEM_CLASS_UUIDS[spec.bindTo as keyof typeof SYSTEM_CLASS_UUIDS];

      const schemaOp = ops[i];
      expect(schemaOp.envelope.opType).toBe('propertySchema.create');
      const expectedSchema: Record<string, unknown> = {
        schemaId,
        name: schemaName,
        type: spec.type,
        isSystem: true,
        scope: 'class',
      };
      if (spec.multi) expectedSchema.multi = true;
      if (spec.classFilter) {
        expectedSchema.classFilterUuids = spec.classFilter.map(
          (c) => SYSTEM_CLASS_UUIDS[c as keyof typeof SYSTEM_CLASS_UUIDS]
        );
      }
      if (spec.options) expectedSchema.options = spec.options;
      if (spec.defaultValue !== undefined) expectedSchema.defaultValue = spec.defaultValue;
      expect(schemaOp.payload).toEqual(expectedSchema);
      expect(schemaOp.envelope.affectedNodeIds).toEqual([schemaId]);

      const sequence = edgeSequencePerClass.get(spec.bindTo) ?? 0;
      edgeSequencePerClass.set(spec.bindTo, sequence + 1);
      const edgeOp = ops[i + 1];
      expect(edgeOp.envelope.opType).toBe('classPropertyEdge.create');
      expect(edgeOp.payload).toEqual({ classId, propertySchemaId: schemaId, sequence });
      expect(edgeOp.envelope.affectedNodeIds).toEqual([classId, schemaId]);
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

    // Subclasses carry their canonical extends parents…
    const byId = new Map(classes.map((c) => [c.id, c]));
    expect(byId.get(SYSTEM_CLASS_UUIDS.book)?.extendsClassIds).toEqual([SYSTEM_CLASS_UUIDS.source]);
    expect(byId.get(SYSTEM_CLASS_UUIDS.person)?.extendsClassIds).toEqual([SYSTEM_CLASS_UUIDS.agent]);
    expect(byId.get(SYSTEM_CLASS_UUIDS.collection)?.extendsClassIds).toEqual([]);

    // …and the hierarchy closure materializes them.
    const closure = queryAll<{ class_id: string; ancestor_id: string }>(
      db,
      'SELECT class_id, ancestor_id FROM class_hierarchy'
    );
    const closurePairs = new Set(closure.map((r) => `${r.class_id}:${r.ancestor_id}`));
    expect(closurePairs.has(`${SYSTEM_CLASS_UUIDS.book}:${SYSTEM_CLASS_UUIDS.source}`)).toBe(true);
    expect(closurePairs.has(`${SYSTEM_CLASS_UUIDS.organization}:${SYSTEM_CLASS_UUIDS.agent}`)).toBe(true);

    // Class-scoped system property schemas and their bindings exist.
    const schemas = queryAll<{ is_system: number; scope: string }>(
      db,
      'SELECT is_system, scope FROM property_schema'
    );
    expect(schemas).toHaveLength(SCHEMA_COUNT);
    for (const schema of schemas) {
      expect(schema.is_system).toBe(1);
      expect(schema.scope).toBe('class');
    }
    const edges = queryAll<{ class_id: string; property_schema_id: string }>(
      db,
      'SELECT class_id, property_schema_id FROM class_property_edge'
    );
    expect(edges).toHaveLength(SCHEMA_COUNT);
    const edgePairs = new Set(edges.map((r) => `${r.class_id}:${r.property_schema_id}`));
    expect(edgePairs.has(`${SYSTEM_CLASS_UUIDS.source}:${SYSTEM_PROPERTY_UUIDS.attachments}`)).toBe(true);
    expect(edgePairs.has(`${SYSTEM_CLASS_UUIDS.asset}:${SYSTEM_PROPERTY_UUIDS.role}`)).toBe(true);
    expect(edgePairs.has(`${SYSTEM_CLASS_UUIDS.weblink}:${SYSTEM_PROPERTY_UUIDS.url}`)).toBe(true);

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

  it('backfills extends, schemas and edges for legacy flat-seeded workspaces', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);
    const client = createWorkspaceStoreClient();
    await client.init(workspaceId, actorId, { store });

    // Simulate a workspace seeded before the source hierarchy existed: all
    // system classes present but flat (no icon/extends), no schemas/edges.
    const legacyOps = buildWorkspaceSeedOperations(workspaceId, actorId, 'Test User')
      .filter((op) =>
        ['class.create', 'node.updateContent', 'node.create'].includes(op.envelope.opType)
      )
      .map((op) => {
        if (op.envelope.opType !== 'class.create') return op;
        const payload = op.payload as { classId: string; name: string };
        return { ...op, payload: { classId: payload.classId, name: payload.name } };
      });
    await client.mutate('applyMany', [legacyOps]);

    const emitted = await ensureLocalWorkspace(client, actorId, 'Test User');
    // class.setExtends per canonical subclass + all schemas + all edges.
    expect(emitted).toBe(Object.keys(SYSTEM_CLASS_EXTENDS).length + SCHEMA_COUNT * 2);

    // Running again converges: nothing left to emit.
    expect(await ensureLocalWorkspace(client, actorId, 'Test User')).toBe(0);

    const book = await client.query<{ extendsClassIds: string[] }>('getClass', [
      SYSTEM_CLASS_UUIDS.book,
    ]);
    expect(book?.extendsClassIds).toEqual([SYSTEM_CLASS_UUIDS.source]);

    const schemas = queryAll<{ id: string }>(db, 'SELECT id FROM property_schema');
    expect(schemas).toHaveLength(SCHEMA_COUNT);
    const edges = queryAll<{ class_id: string }>(db, 'SELECT class_id FROM class_property_edge');
    expect(edges).toHaveLength(SCHEMA_COUNT);
  });
});
