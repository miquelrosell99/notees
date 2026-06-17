/**
 * Tests for serverIdMap.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OperationRuntime } from './OperationRuntime';
import {
  clearServerId,
  getServerId,
  registerParentServerId,
  registerServerId,
  resolveParentServerId,
  setServerId,
} from './serverIdMap';

function baseNode(blockId: string, serverId?: number) {
  return {
    blockId,
    serverId,
    parentId: null,
    orderIndex: 0,
    nodeType: 'block' as const,
    contentAST: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: '' }] }],
    collapsed: false,
    isDeleted: false,
    isPage: false,
    classIds: [],
    tagIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
}

describe('serverIdMap', () => {
  beforeEach(() => {
    clearServerId('block-a');
    clearServerId('block-b');
  });

  it('registers and resolves server ids bidirectionally', () => {
    registerServerId('block-a', 42);
    expect(getServerId('block-a')).toBe(42);
  });

  it('resolves a parent server id from the runtime projection', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode('block-a', 99)]);

    expect(resolveParentServerId(runtime, 'block-a')).toBe(99);
  });

  it('resolves a parent server id from the fallback map', () => {
    const runtime = new OperationRuntime();
    registerParentServerId('block-a', 77);

    expect(resolveParentServerId(runtime, 'block-a')).toBe(77);
  });

  it('falls back to numeric strings for legacy callers', () => {
    const runtime = new OperationRuntime();

    expect(resolveParentServerId(runtime, '123')).toBe(123);
  });

  it('returns null for unresolved UUIDs instead of parsing them as integers', () => {
    const runtime = new OperationRuntime();

    expect(resolveParentServerId(runtime, '00000000-0000-0000-00dd-202606160000')).toBeNull();
    expect(resolveParentServerId(runtime, '550e8400-e29b-41d4-a716-446655440000')).toBeNull();
  });

  it('updates the runtime node server id via setServerId', () => {
    const runtime = new OperationRuntime();
    runtime.loadBaseNodes([baseNode('block-a')]);

    setServerId(runtime, 'block-a', 55);

    expect(resolveParentServerId(runtime, 'block-a')).toBe(55);
    expect(getServerId('block-a')).toBe(55);
  });
});
