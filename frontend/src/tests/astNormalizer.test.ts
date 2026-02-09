/**
 * AST Normalizer Tests
 * 
 * Comprehensive tests for normalization rules and invariants
 */

import { describe, it, expect } from 'vitest';
import { normalizeAST, canFlattenGroup, isGroupEmpty } from '../lib/astNormalizer';
import { SYSTEM_CAPABILITIES } from '../types/queryAST';
import type { QueryAST, GroupNode } from '../types/queryAST';

// Helper to create test AST
function createTestAST(rootGroup: GroupNode): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: {
      type: 'scope',
      scope_type: 'entire_graph',
    },
    root_group: rootGroup,
    created_at: new Date().toISOString(),
  };
}

describe('astNormalizer', () => {
  describe('empty group removal', () => {
    it('should remove empty user groups', () => {
      const ast = createTestAST({
        type: 'group',
        logic: 'AND',
        children: [],
      });
      
      const result = normalizeAST(ast);
      expect(result.root_group.children).toHaveLength(0);
    });
    
    it('should preserve empty system groups', () => {
      const ast = createTestAST({
        type: 'group',
        logic: 'AND',
        children: [],
        capabilities: SYSTEM_CAPABILITIES,
      });
      
      const result = normalizeAST(ast);
      expect(result.root_group.children).toHaveLength(0);
      expect(result.root_group.capabilities).toEqual(SYSTEM_CAPABILITIES);
    });
  });
  
  describe('single-child group flattening', () => {
    it('should flatten single-child user groups', () => {
      const ast = createTestAST({
        type: 'group',
        logic: 'AND',
        children: [
          {
            type: 'group',
            logic: 'AND',
            children: [
              {
                type: 'condition',
                condition_type: 'content',
                operator: 'contains',
                value: 'test',
              },
            ],
          },
        ],
      });
      
      const result = normalizeAST(ast);
      expect(result.root_group.children).toHaveLength(1);
      expect(result.root_group.children[0].type).toBe('condition');
    });
    
    it('should NOT flatten single-child system groups', () => {
      const ast = createTestAST({
        type: 'group',
        logic: 'AND',
        children: [
          {
            type: 'group',
            logic: 'AND',
            children: [
              {
                type: 'condition',
                condition_type: 'content',
                operator: 'contains',
                value: 'test',
              },
            ],
            capabilities: SYSTEM_CAPABILITIES,
          },
        ],
      });
      
      const result = normalizeAST(ast);
      // The user root wrapper is flattened (single child), promoting the system group to root.
      // The system group itself is NOT flattened — it keeps its single condition child.
      expect(result.root_group.capabilities).toEqual(SYSTEM_CAPABILITIES);
      expect(result.root_group.children).toHaveLength(1);
      expect(result.root_group.children[0].type).toBe('condition');
    });
  });
  
  describe('stable ordering', () => {
    it('should place system nodes before user nodes', () => {
      const ast = createTestAST({
        type: 'group',
        logic: 'AND',
        children: [
          {
            type: 'condition',
            condition_type: 'content',
            operator: 'contains',
            value: 'user',
          },
          {
            type: 'condition',
            condition_type: 'content',
            operator: 'contains',
            value: 'system',
            capabilities: SYSTEM_CAPABILITIES,
          },
        ],
      });
      
      const result = normalizeAST(ast);
      expect(result.root_group.children).toHaveLength(2);
      // First child should be system node
      expect(result.root_group.children[0].capabilities).toEqual(SYSTEM_CAPABILITIES);
      // Second child should be user node
      expect(result.root_group.children[1].capabilities).toBeUndefined();
    });
  });
  
  describe('nested normalization', () => {
    it('should normalize deeply nested groups', () => {
      const ast = createTestAST({
        type: 'group',
        logic: 'AND',
        children: [
          {
            type: 'group',
            logic: 'AND',
            children: [
              {
                type: 'group',
                logic: 'AND',
                children: [
                  {
                    type: 'condition',
                    condition_type: 'content',
                    operator: 'contains',
                    value: 'test',
                  },
                ],
              },
            ],
          },
        ],
      });
      
      const result = normalizeAST(ast);
      // Should flatten all the way down to a single condition
      expect(result.root_group.children).toHaveLength(1);
      expect(result.root_group.children[0].type).toBe('condition');
    });
  });
  
  describe('NOT node handling', () => {
    it('should normalize groups inside NOT nodes', () => {
      const ast = createTestAST({
        type: 'group',
        logic: 'AND',
        children: [
          {
            type: 'not',
            child: {
              type: 'group',
              logic: 'AND',
              children: [
                {
                  type: 'condition',
                  condition_type: 'content',
                  operator: 'contains',
                  value: 'test',
                },
              ],
            },
          },
        ],
      });
      
      const result = normalizeAST(ast);
      // The single-child group inside NOT should be flattened
      expect(result.root_group.children).toHaveLength(1);
      expect(result.root_group.children[0].type).toBe('not');
      const notNode = result.root_group.children[0];
      if (notNode.type === 'not') {
        expect(notNode.child.type).toBe('condition');
      }
    });
  });
  
  describe('helper functions', () => {
    it('canFlattenGroup should detect single-child groups', () => {
      const group: GroupNode = {
        type: 'group',
        logic: 'AND',
        children: [
          {
            type: 'condition',
            condition_type: 'content',
            operator: 'contains',
            value: 'test',
          },
        ],
      };
      
      expect(canFlattenGroup(group)).toBe(true);
    });
    
    it('isGroupEmpty should detect empty groups', () => {
      const group: GroupNode = {
        type: 'group',
        logic: 'AND',
        children: [],
      };
      
      expect(isGroupEmpty(group)).toBe(true);
    });
  });
});
