import { describe, expect, it } from 'vitest';
import { detectConflicts } from '../syncConflicts';
import { createOperation } from '../types/operation';

function op(
  opType: string,
  payload: Record<string, unknown>,
  hlc: { physical: number; logical: number } = { physical: 1, logical: 0 },
  id = 'op-id'
) {
  return createOperation(
    {
      id,
      workspaceId: 'ws',
      actorId: 'actor',
      hlc,
      affectedNodeIds: [payload.nodeId as string],
      opType,
    },
    payload
  );
}

describe('detectConflicts', () => {
  it('detects concurrent moves to different parents', () => {
    const remote = op('node.move', { nodeId: 'n1', newParentId: 'p1' }, { physical: 1, logical: 0 }, 'r1');
    const local = op('node.move', { nodeId: 'n1', newParentId: 'p2' }, { physical: 2, logical: 0 }, 'l1');
    const conflicts = detectConflicts([remote], [local]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      nodeUuid: 'n1',
      conflictType: 'move_move',
      localOperationIds: ['l1'],
      remoteOperationIds: ['r1'],
    });
  });

  it('does not flag moves to the same parent as a conflict', () => {
    const remote = op('node.move', { nodeId: 'n1', newParentId: 'p1' }, { physical: 1, logical: 0 }, 'r1');
    const local = op('node.move', { nodeId: 'n1', newParentId: 'p1' }, { physical: 2, logical: 0 }, 'l1');
    expect(detectConflicts([remote], [local])).toHaveLength(0);
  });

  it('detects a remote delete against a local edit', () => {
    const remote = op('node.delete', { nodeId: 'n1' }, { physical: 1, logical: 0 }, 'r1');
    const local = op(
      'node.updateContent',
      { nodeId: 'n1', content: [{ type: 'text', text: 'hi' }] },
      { physical: 2, logical: 0 },
      'l1'
    );
    const conflicts = detectConflicts([remote], [local]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflictType).toBe('node_deleted');
    expect(conflicts[0].localOperationIds).toContain('l1');
    expect(conflicts[0].remoteOperationIds).toContain('r1');
  });

  it('detects a local delete against a remote edit', () => {
    const remote = op(
      'node.updateContent',
      { nodeId: 'n1', content: [{ type: 'text', text: 'hi' }] },
      { physical: 1, logical: 0 },
      'r1'
    );
    const local = op('node.archive', { nodeId: 'n1' }, { physical: 2, logical: 0 }, 'l1');
    const conflicts = detectConflicts([remote], [local]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflictType).toBe('node_deleted');
  });

  it('detects concurrent class assign and unassign', () => {
    const remote = op('class.assign', { nodeId: 'n1', classId: 'c1' }, { physical: 1, logical: 0 }, 'r1');
    const local = op('class.unassign', { nodeId: 'n1', classId: 'c1' }, { physical: 2, logical: 0 }, 'l1');
    const conflicts = detectConflicts([remote], [local]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      nodeUuid: 'n1',
      conflictType: 'class_conflict',
      localOperationIds: ['l1'],
      remoteOperationIds: ['r1'],
    });
  });

  it('detects concurrent property set and unset on the same instance', () => {
    const remote = op(
      'property.set',
      { propertyValueId: 'pv1', nodeId: 'n1', schemaId: 's1', index: 0, value: 'a' },
      { physical: 1, logical: 0 },
      'r1'
    );
    const local = op(
      'property.unset',
      { propertyValueId: 'pv1', nodeId: 'n1', schemaId: 's1', index: 0 },
      { physical: 2, logical: 0 },
      'l1'
    );
    const conflicts = detectConflicts([remote], [local]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      nodeUuid: 'n1',
      conflictType: 'property_conflict',
      localOperationIds: ['l1'],
      remoteOperationIds: ['r1'],
    });
  });

  it('does not flag concurrent text edits as a conflict', () => {
    const remote = op(
      'node.updateContent',
      { nodeId: 'n1', content: [{ type: 'text', text: 'hello' }] },
      { physical: 1, logical: 0 },
      'r1'
    );
    const local = op(
      'node.updateContent',
      { nodeId: 'n1', content: [{ type: 'text', text: 'world' }] },
      { physical: 2, logical: 0 },
      'l1'
    );
    expect(detectConflicts([remote], [local])).toHaveLength(0);
  });
});
