import { describe, it, expect } from 'vitest';
import { createEmptyQueryAST, isEmptyQuery } from '@/types/queryAST';
import type { ConditionNode } from '@/types/queryAST';
import { getExecutionAST } from './helpers';

describe('getExecutionAST', () => {
  it('restores the class condition for classed_nodes views with an empty persisted AST', () => {
    const ast = getExecutionAST(createEmptyQueryAST(), 'classed_nodes', 'class-uuid-1');
    expect(ast).toBeDefined();
    expect(isEmptyQuery(ast!)).toBe(false);
    const condition = ast!.root_group.children.find(
      (c): c is ConditionNode => c.type === 'condition',
    );
    expect(condition).toMatchObject({
      condition_type: 'class',
      class_uuid: 'class-uuid-1',
      operator: 'contains',
    });
  });

  it('restores the extends condition for extended_by views with an empty persisted AST', () => {
    const ast = getExecutionAST(createEmptyQueryAST(), 'extended_by', 'class-uuid-1');
    expect(ast).toBeDefined();
    expect(isEmptyQuery(ast!)).toBe(false);
    const condition = ast!.root_group.children.find(
      (c): c is ConditionNode => c.type === 'condition',
    );
    expect(condition).toMatchObject({ condition_type: 'extends' });
  });

  it('restores the parent condition for child_pages views with an empty persisted AST', () => {
    const ast = getExecutionAST(createEmptyQueryAST(), 'child_pages', 'page-uuid-1');
    expect(ast).toBeDefined();
    expect(isEmptyQuery(ast!)).toBe(false);
    const condition = ast!.root_group.children.find(
      (c): c is ConditionNode => c.type === 'condition',
    );
    expect(condition).toMatchObject({ condition_type: 'parent' });
  });

  it('leaves non-system views untouched', () => {
    const empty = createEmptyQueryAST();
    const ast = getExecutionAST(empty, 'custom', 'node-uuid-1');
    expect(ast).toBe(empty);
    expect(isEmptyQuery(ast!)).toBe(true);
  });

  it('returns undefined for a missing or malformed AST', () => {
    expect(getExecutionAST(undefined, 'classed_nodes', 'class-uuid-1')).toBeUndefined();
    expect(getExecutionAST(null, 'classed_nodes', 'class-uuid-1')).toBeUndefined();
    expect(
      getExecutionAST({ type: 'not-a-query' } as never, 'classed_nodes', 'class-uuid-1'),
    ).toBeUndefined();
  });
});
