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
import { isSystemNode, isNodeRemovable, isNodeEditable } from '@/types/queryAST';
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
  
  // Check if this block is removable/editable
  const canRemove = isNodeRemovable(block);
  const canEdit = isNodeEditable(block);
  const isReadOnly = readOnly || !canEdit;
  
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
  
  // Handle nested group changes (for conditions with nested groups)
  const handleNestedChange = useCallback((children: Array<ConditionNode | GroupNode | ASTNotNode>) => {
    if ('nested_group' in block) {
      const typedCondition = block as any;
      onChange({
        ...typedCondition,
        nested_group: {
          ...typedCondition.nested_group,
          children,
        },
      } as ConditionNode);
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
          {canRemove && !readOnly && (
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
          {canRemove && !readOnly && (
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
  // For conditions that support both static and dynamic modes (like parent),
  // only show nested group UI if dynamic mode is actually being used
  const hasNestedGroup = (() => {
    if (!('nested_group' in condition) || !condition.nested_group) {
      return false;
    }
    
    // For parent condition: only show nested group if static mode (parent_uuid) is NOT set
    if (condition.condition_type === 'parent') {
      const parentCond = condition as any;
      return !parentCond.parent_uuid && !parentCond.parent_id;
    }
    
    // For reference condition: only show nested group if static mode (target_uuid) is NOT set
    if (condition.condition_type === 'reference') {
      const refCond = condition as any;
      return !refCond.target_uuid && !refCond.target_id;
    }
    
    // For other conditions (reference_path, parent_path, child_path), always show nested group
    return true;
  })();
  
  if (hasNestedGroup) {
    // Conditions with nested groups: render the prose + nested QueryBlockList
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
  
  // Simple condition without nesting - no wrapper, ProseConditionBuilder is the card
  return (
    <ProseConditionBuilder
      block={block}
      onChange={onChange as (block: ConditionNode) => void}
      onRemove={onRemove}
      readOnly={isReadOnly}
    />
  );
}

export default QueryBlockBuilder;
