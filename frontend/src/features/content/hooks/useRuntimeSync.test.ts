import { describe, it, expect } from 'vitest';
import { apiNodeToGraphNode } from './useRuntimeSync';
import type { Node } from '@/types/api';

function makeNode(overrides: Partial<Node>): Node {
  return {
    uuid: 'node-1',
    name: '[]',
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: false,
    create_date: '2026-01-01T00:00:00Z',
    write_date: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const coloredClass = makeNode({
  uuid: 'class-1',
  is_class: true,
  color: '#ff0000',
});

describe('apiNodeToGraphNode', () => {
  it('keeps the runtime color as the node own color, not a class-inherited color', () => {
    // A block that has a colored class assigned (e.g. via an inline class
    // reference) must not adopt the class color as its runtime color: the
    // block background tint reflects only the node's own color.
    const block = makeNode({ classes_uuid: ['class-1'] });

    const graphNode = apiNodeToGraphNode(block, [coloredClass]);

    expect(graphNode.color).toBeNull();
    expect(graphNode.classIds).toEqual(['class-1']);
  });

  it('preserves an explicitly set own color', () => {
    const block = makeNode({ color: '#00ff00', classes_uuid: ['class-1'] });

    const graphNode = apiNodeToGraphNode(block, [coloredClass]);

    expect(graphNode.color).toBe('#00ff00');
  });
});
