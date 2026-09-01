import { describe, it, expect } from 'vitest';
import type { Node } from '@/types';
import { buildClassHierarchyTree } from './helpers';

function classNode(uuid: string, name: string, extendsUuid: string[] = []): Node {
  return { uuid, name, extends_uuid: extendsUuid } as unknown as Node;
}

describe('buildClassHierarchyTree', () => {
  it('returns an empty list when there are no subclasses', () => {
    expect(buildClassHierarchyTree([], 'class-a')).toEqual([]);
  });

  it('nests transitive subclasses under their direct superclass', () => {
    // c extends b, b extends a, d extends a → a: [b: [c], d]
    const tree = buildClassHierarchyTree(
      [
        classNode('c', 'C', ['b']),
        classNode('b', 'B', ['a']),
        classNode('d', 'D', ['a']),
      ],
      'a',
    );

    expect(tree.map((n) => n.uuid)).toEqual(['b', 'd']);
    const b = tree[0];
    expect(b.has_children).toBe(true);
    expect(b.children?.map((n) => n.uuid)).toEqual(['c']);
    expect(b.children?.[0].has_children).toBe(false);
    expect(b.children?.[0].children).toBeUndefined();
    expect(tree[1].has_children).toBe(false);
  });

  it('sorts each level alphabetically by name', () => {
    const tree = buildClassHierarchyTree(
      [
        classNode('z', 'Zulu', ['a']),
        classNode('m', 'Mike', ['a']),
        classNode('y', 'Yankee', ['z']),
      ],
      'a',
    );

    expect(tree.map((n) => n.uuid)).toEqual(['m', 'z']);
    expect(tree[1].children?.map((n) => n.uuid)).toEqual(['y']);
  });

  it('attaches multi-inheritance classes once, under their first in-result superclass', () => {
    // d extends both b and c (both extend a) → appears only under b
    const tree = buildClassHierarchyTree(
      [
        classNode('d', 'D', ['b', 'c']),
        classNode('b', 'B', ['a']),
        classNode('c', 'C', ['a']),
      ],
      'a',
    );

    expect(tree.map((n) => n.uuid)).toEqual(['b', 'c']);
    expect(tree[0].children?.map((n) => n.uuid)).toEqual(['d']);
    expect(tree[1].children).toBeUndefined();
  });

  it('falls back to top level when the direct superclass is missing from the result set', () => {
    // b extends x, but x is not a subclass of a → b renders at top level
    const tree = buildClassHierarchyTree([classNode('b', 'B', ['x'])], 'a');
    expect(tree.map((n) => n.uuid)).toEqual(['b']);
  });

  it('terminates on cyclic data instead of recursing forever', () => {
    // b extends c, c extends b — neither extends a directly, but both are in
    // the result set (corrupt data); the cycle guard must keep this finite.
    const tree = buildClassHierarchyTree(
      [classNode('b', 'B', ['c']), classNode('c', 'C', ['b'])],
      'a',
    );
    expect(tree).toEqual([]);
  });
});
