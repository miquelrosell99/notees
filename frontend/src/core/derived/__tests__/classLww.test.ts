import { describe, it, expect } from 'vitest';
import type { Database } from 'sql.js';
import { createOperation, type Operation } from '../../types/operation';
import { applyClassOperation } from '../class';
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
      affectedNodeIds: payload.classId ? [payload.classId as string] : [],
      opType,
    },
    payload
  );
}

function classRow(db: Database, classId: string) {
  return queryOne<{ name: string; active: number; extends_class_ids: string }>(
    db,
    'SELECT name, active, extends_class_ids FROM class WHERE id = ?',
    [classId]
  );
}

// CURRENT_DERIVED_STATE_VERSION is intentionally not bumped for this guard:
// a corrective class.delete op appended to the user's log heals persisted DBs
// where a legacy create already resurrected the class, via normal catch-up.
describe('class lifecycle LWW guards', () => {
  it('a backfilled older-HLC create applied after a newer delete does not resurrect the class', async () => {
    const db = await createTestDatabase();
    const classId = uuidv7();

    applyClassOperation(db, makeOp('class.create', { classId, name: 'source' }, { hlc: { physical: 10, logical: 0 } }));
    applyClassOperation(db, makeOp('class.delete', { classId }, { hlc: { physical: 20, logical: 0 } }));
    expect(classRow(db, classId)?.active).toBe(0);

    // Legacy create replayed at a high server seq but with its old HLC.
    applyClassOperation(db, makeOp('class.create', { classId, name: 'source' }, { hlc: { physical: 10, logical: 0 } }));

    expect(classRow(db, classId)?.active).toBe(0);
  });

  it('a create with a newer HLC than the delete still resurrects the class (intentional re-create)', async () => {
    const db = await createTestDatabase();
    const classId = uuidv7();

    applyClassOperation(db, makeOp('class.create', { classId, name: 'source' }, { hlc: { physical: 10, logical: 0 } }));
    applyClassOperation(db, makeOp('class.delete', { classId }, { hlc: { physical: 20, logical: 0 } }));
    applyClassOperation(db, makeOp('class.create', { classId, name: 'source-v2' }, { hlc: { physical: 30, logical: 0 } }));

    const row = classRow(db, classId);
    expect(row?.active).toBe(1);
    expect(row?.name).toBe('source-v2');
  });

  it('an update with an older HLC than the last applied op is a no-op', async () => {
    const db = await createTestDatabase();
    const classId = uuidv7();

    applyClassOperation(db, makeOp('class.create', { classId, name: 'original' }, { hlc: { physical: 10, logical: 0 } }));
    applyClassOperation(db, makeOp('class.update', { classId, name: 'newer' }, { hlc: { physical: 20, logical: 0 } }));
    applyClassOperation(db, makeOp('class.update', { classId, name: 'older' }, { hlc: { physical: 15, logical: 0 } }));

    expect(classRow(db, classId)?.name).toBe('newer');
  });

  it('a setExtends with an older HLC than the delete is a no-op', async () => {
    const db = await createTestDatabase();
    const classId = uuidv7();
    const parentId = uuidv7();

    applyClassOperation(db, makeOp('class.create', { classId: parentId, name: 'parent' }, { hlc: { physical: 5, logical: 0 } }));
    applyClassOperation(db, makeOp('class.create', { classId, name: 'child' }, { hlc: { physical: 10, logical: 0 } }));
    applyClassOperation(db, makeOp('class.delete', { classId }, { hlc: { physical: 20, logical: 0 } }));
    applyClassOperation(
      db,
      makeOp('class.setExtends', { classId, extendsClassIds: [parentId] }, { hlc: { physical: 12, logical: 0 } })
    );

    const row = classRow(db, classId);
    expect(row?.active).toBe(0);
    expect(JSON.parse(row!.extends_class_ids)).toEqual([]);
  });
});
