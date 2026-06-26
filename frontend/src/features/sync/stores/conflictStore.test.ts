import { describe, it, expect } from 'vitest';
import { useConflictStore } from './conflictStore';
import type { Node } from '@/types/api';

function makeNode(uuid: string, name: string): Node {
  return {
    uuid,
    name,
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: false,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
  };
}

describe('conflictStore', () => {
  it('adds and resolves conflicts per workspace', () => {
    useConflictStore.getState().addConflict({
      workspaceUuid: 'ws-1',
      nodeUuid: 'node-1',
      conflictType: 'text_edit',
      baseNode: makeNode('node-1', 'base'),
      ourNode: makeNode('node-1', 'ours'),
      theirNode: makeNode('node-1', 'theirs'),
      operationIds: ['op-1'],
      createdAt: Date.now(),
    });

    const ws1 = useConflictStore.getState().getConflictsForWorkspace('ws-1');
    expect(ws1).toHaveLength(1);
    expect(ws1[0].conflictType).toBe('text_edit');

    useConflictStore.getState().resolveConflict('ws-1', 'node-1');
    expect(useConflictStore.getState().getConflictsForWorkspace('ws-1')).toHaveLength(0);
  });

  it('isolates workspaces', () => {
    useConflictStore.getState().addConflict({
      workspaceUuid: 'ws-a',
      nodeUuid: 'node-x',
      conflictType: 'tree_conflict',
      baseNode: null,
      ourNode: null,
      theirNode: null,
      operationIds: [],
      createdAt: Date.now(),
    });

    expect(useConflictStore.getState().getConflictsForWorkspace('ws-b')).toHaveLength(0);
    expect(useConflictStore.getState().getConflictsForWorkspace('ws-a')).toHaveLength(1);

    useConflictStore.getState().clearWorkspace('ws-a');
    expect(useConflictStore.getState().getConflictsForWorkspace('ws-a')).toHaveLength(0);
  });
});
