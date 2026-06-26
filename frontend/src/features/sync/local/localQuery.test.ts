/**
 * Unit tests for offline local query evaluation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { queryNodesLocal } from './localQuery';
import { addOrUpdateNodes, _resetMemoryStore } from './localNodeStore';
import { createEmptyQueryAST } from '@/types/queryAST';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { paragraph, text, nodeLink } from '@/lib/astBuilder';
import type { Node } from '@/types/api';

const WORKSPACE = 'ws-query-1';

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

describe('queryNodesLocal AST branch', () => {
  beforeEach(() => {
    _resetMemoryStore();
  });

  it('evaluates a linked-references QueryAST offline', async () => {
    const target = makeNode('target-1', [paragraph(text('Target page'))], { is_page: true });
    const sourceBlock = makeNode('source-1', [
      paragraph(text('See '), nodeLink('target-1')),
    ]);
    const unrelated = makeNode('unrelated-1', [paragraph(text('No link'))], { is_page: true });

    await addOrUpdateNodes(WORKSPACE, [target, sourceBlock, unrelated]);

    const baseAst = createEmptyQueryAST();
    const ast = autoFixSystemQuery(baseAst, 'linked_references', { nodeUuid: 'target-1' });

    const matches = await queryNodesLocal(WORKSPACE, {
      ast,
      runtimeParams: { current_node_uuid: 'target-1' },
    });

    expect(matches.map((n) => n.uuid)).toEqual(['source-1']);
  });

  it('excludes the current page from linked-references results', async () => {
    const target = makeNode('target-1', [
      paragraph(text('Self reference '), nodeLink('target-1')),
    ], { is_page: true });

    await addOrUpdateNodes(WORKSPACE, [target]);

    const baseAst = createEmptyQueryAST();
    const ast = autoFixSystemQuery(baseAst, 'linked_references', { nodeUuid: 'target-1' });

    const matches = await queryNodesLocal(WORKSPACE, {
      ast,
      runtimeParams: { current_node_uuid: 'target-1' },
    });

    expect(matches).toHaveLength(0);
  });

  it('respects the 500-node result cap', async () => {
    const target = makeNode('target-1', [paragraph(text('Target'))], { is_page: true });
    const sources: Node[] = [];
    for (let i = 0; i < 550; i++) {
      sources.push(makeNode(`source-${i}`, [
        paragraph(text('Ref '), nodeLink('target-1')),
      ]));
    }
    await addOrUpdateNodes(WORKSPACE, [target, ...sources]);

    const baseAst = createEmptyQueryAST();
    const ast = autoFixSystemQuery(baseAst, 'linked_references', { nodeUuid: 'target-1' });

    const matches = await queryNodesLocal(WORKSPACE, {
      ast,
      runtimeParams: { current_node_uuid: 'target-1' },
    });

    expect(matches).toHaveLength(500);
  });
});
