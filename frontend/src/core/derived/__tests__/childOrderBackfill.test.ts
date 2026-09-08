import { describe, it, expect } from 'vitest';
import type { Database } from 'sql.js';
import { createOperation, type Operation } from '../../types/operation';
import { applyOperation } from '../index';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { queryAll } from '../../db/sqlite';

const WORKSPACE_ID = uuidv7();

function makeOp(
  opType: string,
  payload: Record<string, unknown>,
  overrides: { actorId?: string; hlc: { physical: number; logical: number } }
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

function childOrder(db: Database, parentId: string): string[] {
  return queryAll<{ child_id: string }>(
    db,
    'SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position',
    [parentId]
  ).map((row) => row.child_id);
}

describe('legacy positional child-order backfill', () => {
  it('node.create with parentId + index materializes node_child_order', async () => {
    const db = await createTestDatabase();
    const parentId = uuidv7();
    const childA = uuidv7();
    const childB = uuidv7();
    const childC = uuidv7();

    applyOperation(db, makeOp('node.create', { nodeId: parentId, kind: 'page', parentId: null }, { hlc: { physical: 1, logical: 0 } }));
    applyOperation(db, makeOp('node.create', { nodeId: childA, kind: 'block', parentId, index: 0 }, { hlc: { physical: 2, logical: 0 } }));
    applyOperation(db, makeOp('node.create', { nodeId: childB, kind: 'block', parentId, index: 1 }, { hlc: { physical: 3, logical: 0 } }));
    // Insert between A and B, legacy positional style.
    applyOperation(db, makeOp('node.create', { nodeId: childC, kind: 'block', parentId, index: 1 }, { hlc: { physical: 4, logical: 0 } }));

    expect(childOrder(db, parentId)).toEqual([childA, childC, childB]);
  });

  it('legacy node.move with newIndex reorders and cleans the old parent tree', async () => {
    const db = await createTestDatabase();
    const parentA = uuidv7();
    const parentB = uuidv7();
    const child1 = uuidv7();
    const child2 = uuidv7();

    applyOperation(db, makeOp('node.create', { nodeId: parentA, kind: 'page', parentId: null }, { hlc: { physical: 1, logical: 0 } }));
    applyOperation(db, makeOp('node.create', { nodeId: parentB, kind: 'page', parentId: null }, { hlc: { physical: 2, logical: 0 } }));
    applyOperation(db, makeOp('node.create', { nodeId: child1, kind: 'block', parentId: parentA, index: 0 }, { hlc: { physical: 3, logical: 0 } }));
    applyOperation(db, makeOp('node.create', { nodeId: child2, kind: 'block', parentId: parentA, index: 1 }, { hlc: { physical: 4, logical: 0 } }));

    expect(childOrder(db, parentA)).toEqual([child1, child2]);

    // Legacy cross-parent move to index 0 of parentB.
    applyOperation(
      db,
      makeOp('node.move', { nodeId: child1, newParentId: parentB, newIndex: 0 }, { hlc: { physical: 5, logical: 0 } })
    );

    expect(childOrder(db, parentA)).toEqual([child2]);
    expect(childOrder(db, parentB)).toEqual([child1]);
  });

  it('a replay mixing legacy positional ops and treeUpdate ops converges', async () => {
    const db = await createTestDatabase();
    const parentId = uuidv7();
    const childA = uuidv7();
    const childB = uuidv7();
    const childC = uuidv7();

    applyOperation(db, makeOp('node.create', { nodeId: parentId, kind: 'page', parentId: null }, { hlc: { physical: 1, logical: 0 } }));
    applyOperation(db, makeOp('node.create', { nodeId: childA, kind: 'block', parentId, index: 0 }, { hlc: { physical: 2, logical: 0 } }));
    applyOperation(db, makeOp('node.create', { nodeId: childB, kind: 'block', parentId, index: 1 }, { hlc: { physical: 3, logical: 0 } }));

    // Era switch: from here on, structure changes arrive as treeUpdate ops.
    const { loadTreeCrdtClean } = await import('../childOrder');
    const { saveTreeCrdt } = await import('../crdtState');
    const tree = loadTreeCrdtClean(db, parentId);
    tree.insert(childC, 1);
    saveTreeCrdt(db, parentId, tree);
    applyOperation(
      db,
      makeOp(
        'node.updateContent',
        { nodeId: parentId, treeUpdate: Array.from(tree.getState()) },
        { hlc: { physical: 4, logical: 0 } }
      )
    );

    expect(childOrder(db, parentId)).toEqual([childA, childC, childB]);
  });
});
