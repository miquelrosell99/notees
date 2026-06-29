/**
 * Tests for the v2 sync intent mapper.
 */
import { describe, it, expect } from 'vitest';
import { operationToIntentV2 } from './syncV2';
import type { Operation } from '@/runtime';

function op(
  overrides: Partial<Operation> & { id: string; type: Operation['type']; blockId: string }
): Operation {
  return {
    state: 'pending',
    dependsOn: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: {} as Operation['payload'],
    ...overrides,
  } as Operation;
}

describe('operationToIntentV2', () => {
  it('maps create with parent and anchor', () => {
    const operation = op({
      id: 'op-1',
      type: 'create',
      blockId: 'new',
      payload: {
        parentId: 'parent',
        afterBlockId: 'after',
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hi' }] }],
      },
    });

    const intent = operationToIntentV2(operation, 'client-1', 1);
    expect(intent).toEqual({
      type: 'create',
      client_id: 'client-1',
      seq: 1,
      node_uuid: 'new',
      parent_uuid: 'parent',
      after_uuid: 'after',
      content_ast: [{ type: 'paragraph', children: [{ type: 'text', text: 'hi' }] }],
      class_uuids: null,
      tag_uuids: null,
    });
  });

  it('maps create with classes and tags', () => {
    const operation = op({
      id: 'op-1',
      type: 'create',
      blockId: 'new',
      payload: {
        parentId: 'parent',
        afterBlockId: null,
        contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hi' }] }],
        classIds: ['class-a'],
        tagIds: ['tag-a'],
      },
    });

    const intent = operationToIntentV2(operation, 'client-1', 1);
    expect(intent).toEqual({
      type: 'create',
      client_id: 'client-1',
      seq: 1,
      node_uuid: 'new',
      parent_uuid: 'parent',
      after_uuid: null,
      content_ast: [{ type: 'paragraph', children: [{ type: 'text', text: 'hi' }] }],
      class_uuids: ['class-a'],
      tag_uuids: ['tag-a'],
    });
  });

  it('maps move_node to a move intent', () => {
    const operation = op({
      id: 'op-1',
      type: 'move_node',
      blockId: 'block',
      payload: { parentId: 'parent', afterBlockId: 'after' },
    });

    const intent = operationToIntentV2(operation, 'client-1', 2);
    expect(intent).toEqual({
      type: 'move',
      client_id: 'client-1',
      seq: 2,
      node_uuid: 'block',
      parent_uuid: 'parent',
      after_uuid: 'after',
    });
  });

  it('maps set_classes to an update_node intent with class_uuids', () => {
    const operation = op({
      id: 'op-1',
      type: 'set_classes',
      blockId: 'block',
      payload: { classIds: ['class-a', 'class-b'] },
    });

    const intent = operationToIntentV2(operation, 'client-1', 3);
    expect(intent).toEqual({
      type: 'update_node',
      client_id: 'client-1',
      seq: 3,
      node_uuid: 'block',
      properties: { class_uuids: ['class-a', 'class-b'] },
    });
  });

  it('maps set_tags to an update_node intent with tag_uuids', () => {
    const operation = op({
      id: 'op-1',
      type: 'set_tags',
      blockId: 'block',
      payload: { tagIds: ['tag-a', 'tag-b'] },
    });

    const intent = operationToIntentV2(operation, 'client-1', 4);
    expect(intent).toEqual({
      type: 'update_node',
      client_id: 'client-1',
      seq: 4,
      node_uuid: 'block',
      properties: { tag_uuids: ['tag-a', 'tag-b'] },
    });
  });

  it('drops local-only set_collapsed operations', () => {
    const operation = op({
      id: 'op-1',
      type: 'set_collapsed',
      blockId: 'block',
      payload: { collapsed: true },
    });

    const intent = operationToIntentV2(operation, 'client-1', 5);
    expect(intent).toBeNull();
  });
});
