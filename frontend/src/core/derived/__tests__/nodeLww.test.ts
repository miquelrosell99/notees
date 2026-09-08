import { describe, it, expect } from 'vitest';
import type { Database } from 'sql.js';
import { createOperation, type Operation } from '../../types/operation';
import { applyOperation } from '../index';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { queryOne } from '../../db/sqlite';

const WORKSPACE_ID = uuidv7();

function makeOp(
  opType: string,
  payload: Record<string, unknown>,
  overrides: {
    actorId?: string;
    hlc: { physical: number; logical: number };
  }
): Operation {
  return createOperation(
    {
      workspaceId: WORKSPACE_ID,
      actorId: overrides.actorId ?? 'actor-a',
      hlc: overrides.hlc,
      affectedNodeIds: payload.nodeId ? [payload.nodeId as string] : [],
      opType,
    },
    payload
  );
}

function createNode(db: Database, nodeId: string): void {
  applyOperation(
    db,
    makeOp(
      'node.create',
      { nodeId, kind: 'page', parentId: null, initialContent: [] },
      { hlc: { physical: 1, logical: 0 } }
    )
  );
}

function nodeRow(db: Database, nodeId: string) {
  return queryOne<{
    icon: string | null;
    color: string | null;
    active: number;
    parent_id: string | null;
    kind: string;
    class_ids: string;
  }>(db, 'SELECT icon, color, active, parent_id, kind, class_ids FROM node WHERE id = ?', [nodeId]);
}

describe('node scalar-field LWW guards', () => {
  it('a late-arriving older-HLC icon update does not regress the newer value', async () => {
    const db = await createTestDatabase();
    const nodeId = uuidv7();
    createNode(db, nodeId);

    applyOperation(db, makeOp('node.updateIcon', { nodeId, icon: 'new' }, { hlc: { physical: 20, logical: 0 } }));
    applyOperation(db, makeOp('node.updateIcon', { nodeId, icon: 'old' }, { hlc: { physical: 10, logical: 0 } }));

    expect(nodeRow(db, nodeId)?.icon).toBe('new');
  });

  it('a newer-HLC color update wins regardless of arrival order', async () => {
    const db = await createTestDatabase();
    const nodeId = uuidv7();
    createNode(db, nodeId);

    applyOperation(db, makeOp('node.updateColor', { nodeId, color: 'red' }, { hlc: { physical: 10, logical: 0 } }));
    applyOperation(db, makeOp('node.updateColor', { nodeId, color: 'blue' }, { hlc: { physical: 20, logical: 0 } }));

    expect(nodeRow(db, nodeId)?.color).toBe('blue');
  });

  it('archive/restore resolves by HLC, not arrival order', async () => {
    const db = await createTestDatabase();
    const nodeId = uuidv7();
    createNode(db, nodeId);

    // Restore (t=20) applied first (e.g. local optimistic), then the older
    // archive (t=10) arrives from a pull: it must not regress the restore.
    applyOperation(db, makeOp('node.restore', { nodeId }, { hlc: { physical: 20, logical: 0 } }));
    applyOperation(db, makeOp('node.archive', { nodeId }, { hlc: { physical: 10, logical: 0 } }));

    expect(nodeRow(db, nodeId)?.active).toBe(1);
  });

  it('a late older move does not override a newer parent', async () => {
    const db = await createTestDatabase();
    const nodeId = uuidv7();
    const parentA = uuidv7();
    const parentB = uuidv7();
    createNode(db, nodeId);

    applyOperation(db, makeOp('node.move', { nodeId, newParentId: parentB }, { hlc: { physical: 20, logical: 0 } }));
    applyOperation(db, makeOp('node.move', { nodeId, newParentId: parentA }, { hlc: { physical: 10, logical: 0 } }));

    expect(nodeRow(db, nodeId)?.parent_id).toBe(parentB);
  });

  it('class assign/unassign resolves by HLC across actors', async () => {
    const db = await createTestDatabase();
    const nodeId = uuidv7();
    const classId = uuidv7();
    createNode(db, nodeId);

    applyOperation(
      db,
      makeOp('class.unassign', { nodeId, classId }, { hlc: { physical: 20, logical: 0 }, actorId: 'actor-a' })
    );
    applyOperation(
      db,
      makeOp('class.assign', { nodeId, classId }, { hlc: { physical: 10, logical: 0 }, actorId: 'actor-b' })
    );

    expect(JSON.parse(nodeRow(db, nodeId)!.class_ids)).not.toContain(classId);
  });

  it('equal HLCs resolve deterministically by actor id', async () => {
    const db = await createTestDatabase();
    const nodeId = uuidv7();
    createNode(db, nodeId);

    // Same HLC: 'actor-b' > 'actor-a', so 'actor-b' wins even arriving first.
    applyOperation(
      db,
      makeOp('node.updateIcon', { nodeId, icon: 'b-icon' }, { hlc: { physical: 10, logical: 0 }, actorId: 'actor-b' })
    );
    applyOperation(
      db,
      makeOp('node.updateIcon', { nodeId, icon: 'a-icon' }, { hlc: { physical: 10, logical: 0 }, actorId: 'actor-a' })
    );

    expect(nodeRow(db, nodeId)?.icon).toBe('b-icon');
  });

  it('an older convert does not regress a newer move, but still claims untouched fields', async () => {
    const db = await createTestDatabase();
    const nodeId = uuidv7();
    const parentNew = uuidv7();
    createNode(db, nodeId);

    applyOperation(db, makeOp('node.move', { nodeId, newParentId: parentNew }, { hlc: { physical: 20, logical: 0 } }));
    applyOperation(
      db,
      makeOp(
        'node.convert',
        { nodeId, kind: 'block', parentId: null, classIds: [] },
        { hlc: { physical: 10, logical: 0 } }
      )
    );

    const row = nodeRow(db, nodeId);
    expect(row?.parent_id).toBe(parentNew); // newer move kept
    expect(row?.kind).toBe('block'); // kind had no newer claimant
  });

  it('node.delete clears the field LWW records', async () => {
    const db = await createTestDatabase();
    const nodeId = uuidv7();
    createNode(db, nodeId);
    applyOperation(db, makeOp('node.updateIcon', { nodeId, icon: 'x' }, { hlc: { physical: 10, logical: 0 } }));

    applyOperation(db, makeOp('node.delete', { nodeId }, { hlc: { physical: 30, logical: 0 } }));

    const leftover = queryOne(
      db,
      'SELECT node_id FROM node_field_lww WHERE node_id = ?',
      [nodeId]
    );
    expect(leftover).toBeUndefined();
  });
});

describe('replay equivalence (any permitted arrival order converges)', () => {
  it('shuffled arrival produces the same derived state as HLC order', async () => {
    const nodeId = uuidv7();
    const parentA = uuidv7();
    const parentB = uuidv7();
    const classA = uuidv7();
    const classB = uuidv7();

    // Causally independent ops against the same node, crafted so plain
    // arrival-order application would diverge: every pair disagrees.
    const ops: Operation[] = [
      makeOp('node.updateIcon', { nodeId, icon: 'icon-t10' }, { hlc: { physical: 10, logical: 0 }, actorId: 'actor-a' }),
      makeOp('node.updateIcon', { nodeId, icon: 'icon-t30' }, { hlc: { physical: 30, logical: 0 }, actorId: 'actor-b' }),
      makeOp('node.updateIcon', { nodeId, icon: 'icon-t20' }, { hlc: { physical: 20, logical: 0 }, actorId: 'actor-a' }),
      makeOp('node.updateColor', { nodeId, color: 'c30' }, { hlc: { physical: 30, logical: 0 }, actorId: 'actor-a' }),
      makeOp('node.updateColor', { nodeId, color: 'c15' }, { hlc: { physical: 15, logical: 0 }, actorId: 'actor-b' }),
      makeOp('node.move', { nodeId, newParentId: parentA }, { hlc: { physical: 12, logical: 0 } }),
      makeOp('node.move', { nodeId, newParentId: parentB }, { hlc: { physical: 25, logical: 0 } }),
      makeOp('node.archive', { nodeId }, { hlc: { physical: 18, logical: 0 } }),
      makeOp('node.restore', { nodeId }, { hlc: { physical: 28, logical: 0 } }),
      makeOp('class.assign', { nodeId, classId: classA }, { hlc: { physical: 11, logical: 0 } }),
      makeOp('class.assign', { nodeId, classId: classB }, { hlc: { physical: 22, logical: 0 }, actorId: 'actor-b' }),
      makeOp('class.unassign', { nodeId, classId: classA }, { hlc: { physical: 26, logical: 0 } }),
    ];

    const byHlc = (a: Operation, b: Operation): number =>
      a.envelope.hlc.physical - b.envelope.hlc.physical ||
      a.envelope.hlc.logical - b.envelope.hlc.logical ||
      a.envelope.id.localeCompare(b.envelope.id);

    const applyAll = async (order: Operation[]) => {
      const db = await createTestDatabase();
      createNode(db, nodeId);
      for (const op of order) applyOperation(db, op);
      return nodeRow(db, nodeId);
    };

    const reference = await applyAll([...ops].sort(byHlc));

    // Adversarial orders: reversed and a fixed shuffle. Create always goes
    // first (causal precondition); the rest arrive scrambled.
    const reversed = [...ops].reverse();
    const shuffled = [ops[5], ops[10], ops[1], ops[8], ops[3], ops[11], ops[0], ops[6], ops[9], ops[2], ops[7], ops[4]];

    for (const order of [reversed, shuffled]) {
      const result = await applyAll(order);
      expect(result?.icon).toBe(reference?.icon);
      expect(result?.color).toBe(reference?.color);
      expect(result?.active).toBe(reference?.active);
      expect(result?.parent_id).toBe(reference?.parent_id);
      expect(JSON.parse(result!.class_ids).sort()).toEqual(JSON.parse(reference!.class_ids).sort());
    }

    // Sanity: the reference state is the true LWW outcome, not an accident.
    expect(reference?.icon).toBe('icon-t30');
    expect(reference?.color).toBe('c30');
    expect(reference?.active).toBe(1);
    expect(reference?.parent_id).toBe(parentB);
    expect(JSON.parse(reference!.class_ids).sort()).toEqual([classB].sort());
  });
});
