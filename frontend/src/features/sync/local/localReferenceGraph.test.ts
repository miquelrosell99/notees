/**
 * Unit tests for the local reference graph builder.
 */

import { describe, it, expect } from 'vitest';
import { buildLocalReferenceGraph } from './localReferenceGraph';
import { paragraph, text, nodeLink } from '@/lib/astBuilder';
import type { Node } from '@/types/api';

function makeNode(uuid: string, name: unknown, overrides: Partial<Node> = {}): Node {
  return {
    uuid,
    name: JSON.stringify(name),
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: false,
    create_date: new Date().toISOString(),
    write_date: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildLocalReferenceGraph', () => {
  it('derives parent links from parent_uuid', () => {
    const page = makeNode('p1', [paragraph(text('Page'))], { is_page: true });
    const child = makeNode('b1', [paragraph(text('Block'))], { parent_uuid: 'p1' });
    const { nodes, links } = buildLocalReferenceGraph([page, child]);

    expect(nodes).toHaveLength(2);
    expect(links).toContainEqual({ source: 'p1', target: 'b1', type: 'parent' });
  });

  it('derives reference links from node_link AST nodes', () => {
    const target = makeNode('target-1', [paragraph(text('Target'))], { is_page: true });
    const source = makeNode('source-1', [
      paragraph(text('See '), nodeLink('target-1'), text(' now')),
    ]);
    const { links } = buildLocalReferenceGraph([target, source]);

    expect(links).toContainEqual({ source: 'source-1', target: 'target-1', type: 'reference' });
  });

  it('derives class membership links from classes_uuid', () => {
    const cls = makeNode('class-1', [paragraph(text('Class'))], { is_class: true });
    const member = makeNode('member-1', [paragraph(text('Member'))], { classes_uuid: ['class-1'] });
    const { links } = buildLocalReferenceGraph([cls, member]);

    expect(links).toContainEqual({ source: 'member-1', target: 'class-1', type: 'class' });
  });

  it('derives extends links from extends_uuid', () => {
    const parent = makeNode('parent-1', [paragraph(text('Parent'))], { is_class: true });
    const child = makeNode('child-1', [paragraph(text('Child'))], {
      is_class: true,
      extends_uuid: ['parent-1'],
    });
    const { links } = buildLocalReferenceGraph([parent, child]);

    expect(links).toContainEqual({ source: 'child-1', target: 'parent-1', type: 'extends' });
  });

  it('skips self-references', () => {
    const node = makeNode('self-1', [
      paragraph(text('Link to '), nodeLink('self-1')),
    ]);
    const { links } = buildLocalReferenceGraph([node]);

    expect(links.filter((l) => l.type === 'reference')).toHaveLength(0);
  });
});
