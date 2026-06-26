/**
 * Unit tests for QueryAST runtime-param substitution.
 */

import { describe, it, expect } from 'vitest';
import { substituteRuntimeParams } from './substituteRuntimeParams';
import { createEmptyQueryAST, createContentCondition, createClassCondition } from '@/types/queryAST';

describe('substituteRuntimeParams', () => {
  it('replaces {current_node_uuid} in condition values', () => {
    const ast = createEmptyQueryAST();
    ast.root_group.children = [createClassCondition('{current_node_uuid}')];

    const result = substituteRuntimeParams(ast, { current_node_uuid: 'uuid-123' });
    const condition = result.root_group.children[0];
    expect(condition.type).toBe('condition');
    if (condition.type === 'condition' && condition.condition_type === 'class') {
      expect(condition.class_uuid).toBe('uuid-123');
    }
  });

  it('replaces {current_node_name} in content conditions', () => {
    const ast = createEmptyQueryAST();
    ast.root_group.children = [createContentCondition('contains', '{current_node_name}')];

    const result = substituteRuntimeParams(ast, { current_node_name: 'My Page' });
    const condition = result.root_group.children[0];
    expect(condition.type).toBe('condition');
    if (condition.type === 'condition' && condition.condition_type === 'content') {
      expect(condition.value).toBe('My Page');
    }
  });

  it('leaves non-placeholder values unchanged', () => {
    const ast = createEmptyQueryAST();
    ast.root_group.children = [createClassCondition('class-42')];

    const result = substituteRuntimeParams(ast, { current_node_uuid: 'uuid-123' });
    const condition = result.root_group.children[0];
    expect(condition.type).toBe('condition');
    if (condition.type === 'condition' && condition.condition_type === 'class') {
      expect(condition.class_uuid).toBe('class-42');
    }
  });

  it('does not mutate the original AST', () => {
    const ast = createEmptyQueryAST();
    ast.root_group.children = [createClassCondition('{current_node_uuid}')];

    substituteRuntimeParams(ast, { current_node_uuid: 'uuid-123' });
    const condition = ast.root_group.children[0];
    expect(condition.type).toBe('condition');
    if (condition.type === 'condition' && condition.condition_type === 'class') {
      expect(condition.class_uuid).toBe('{current_node_uuid}');
    }
  });
});
