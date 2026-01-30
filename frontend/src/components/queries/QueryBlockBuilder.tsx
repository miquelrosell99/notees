/**
 * QueryBlockBuilder Component
 * 
 * Renders a single query block (condition, group, or NOT).
 * Delegates to appropriate sub-components and handles recursion for groups.
 */

import { useCallback } from 'react';
import { QueryBlockList } from './QueryBlockList';
import { ProseConditionBuilder } from './ProseConditionBuilder';
import { Button } from '../core/Button';
import { DeleteIcon } from '../icons';
import { isSystemNode } from '@/types/queryAST';
import type { GroupNode, ConditionNode, NotNode as ASTNotNode } from '@/types/queryAST';
import './QueryBlockBuilder.css';

// ==================== Types ====================

interface QueryBlockBuilderProps {
  /** The block to render */
  block: ConditionNode | GroupNode | ASTNotNode;
  /** Callback when block changes */
  onChange: (block: ConditionNode | GroupNode | ASTNotNode) => void;
  /** Callback when block should be removed */
  onRemove: () => void;
  /** Whether this block is read-only */
  readOnly?: boolean;
}

// ==================== Main Component ====================

export function QueryBlockBuilder({
  block,
  onChange,
  onRemove,
  readOnly = false,
}: QueryBlockBuilderProps) {
  
  // Check if this is a system block (locked)
  const isSystem = isSystemNode(block);
  const isReadOnly = readOnly || isSystem;
  
  // Handle group changes
  const handleGroupChange = useCallback((children: Array<ConditionNode | GroupNode | ASTNotNode>) => {
    if (block.type === 'group') {
      onChange({
        ...block,
        children,
      });
    }
  }, [block, onChange]);
  
  // Handle NOT child change
  const handleNotChildChange = useCallback((child: ConditionNode | GroupNode | ASTNotNode) => {
    if (block.type === 'not') {
      onChange({
        ...block,
        child,
      });
    }
  }, [block, onChange]);
  
  // Render based on block type
  if (block.type === 'group') {
    const groupBlock = block as GroupNode;
    return (
      <div className="query-block-builder query-block-builder--group">
        <div className="query-block-builder__header">
          <span className="query-block-builder__label">
            {groupBlock.logic} Group
          </span>
          {!isReadOnly && (
            <Button
              variant="ghost"
              size="xs"
              onClick={onRemove}
              title="Remove group"
            >
              <DeleteIcon size="sm" />
            </Button>
          )}
        </div>
        
        <div className="query-block-builder__body">
          <QueryBlockList
            blocks={groupBlock.children}
            parentLogic={groupBlock.logic}
            onChange={handleGroupChange}
            readOnly={isReadOnly}
          />
        </div>
      </div>
    );
  }
  
  if (block.type === 'not') {
    const notBlock = block as ASTNotNode;
    return (
      <div className="query-block-builder query-block-builder--not">
        <div className="query-block-builder__header">
          <span className="query-block-builder__label">NOT</span>
          {!isReadOnly && (
            <Button
              variant="ghost"
              size="xs"
              onClick={onRemove}
              title="Remove NOT"
            >
              <DeleteIcon size="sm" />
            </Button>
          )}
        </div>
        
        <div className="query-block-builder__body">
          <QueryBlockBuilder
            block={notBlock.child}
            onChange={handleNotChildChange}
            onRemove={() => {}}
            readOnly={isReadOnly}
          />
        </div>
      </div>
    );
  }
  
  // Regular condition
  const condition = block as ConditionNode;
  
  // Check if this condition has a nested group (parent, child, reference_path, etc.)
  const hasNestedGroup = 'nested_group' in condition && condition.nested_group;
  
  if (hasNestedGroup) {
    // Conditions with nested groups: render the prose + nested QueryBlockList
    const handleNestedChange = useCallback((children: Array<ConditionNode | GroupNode | ASTNotNode>) => {
      const typedCondition = condition as any;
      onChange({
        ...typedCondition,
        nested_group: {
          ...typedCondition.nested_group,
          children,
        },
      } as ConditionNode);
    }, [condition, onChange]);
    
    return (
      <div className="query-block-builder query-block-builder--nested">
        {/* Condition header with prose description */}
        <div className="query-block-builder__nested-header">
          <ProseConditionBuilder
            block={condition}
            onChange={onChange as (block: ConditionNode) => void}
            onRemove={onRemove}
            readOnly={isReadOnly}
          />
        </div>
        
        {/* Nested group */}
        {condition.nested_group && (
          <div className="query-block-builder__nested-body">
            <QueryBlockList
              blocks={condition.nested_group.children}
              parentLogic={condition.nested_group.logic}
              onChange={handleNestedChange}
              readOnly={isReadOnly}
            />
          </div>
        )}
      </div>
    );
  }
  
  // Simple condition without nesting
  return (
    <div className="query-block-builder query-block-builder--condition">
      <ProseConditionBuilder
        block={block}
        onChange={onChange as (block: ConditionNode) => void}
        onRemove={onRemove}
        readOnly={isReadOnly}
      />
    </div>
  );
}

export default QueryBlockBuilder;
