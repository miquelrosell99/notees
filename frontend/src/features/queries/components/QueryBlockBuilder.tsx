/**
 * QueryBlockBuilder Component
 * 
 * Renders a single query block (condition, group, or NOT).
 * Delegates to appropriate sub-components and handles recursion for groups.
 */

import { useCallback } from 'react';
import { QueryBlockList } from './QueryBlockList';
import { QueryBlockCard } from './QueryBlockCard';
import { ProseConditionBuilder } from './ProseConditionBuilder';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { operatorNeedsValue } from './conditionConfigs';
import { isNodeRemovable, isNodeEditable } from '@/types/queryAST';
import type { GroupNode, ConditionNode, NotNode as ASTNotNode, LogicType } from '@/types/queryAST';
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
    if (block.type === 'condition' && 'nested_group' in block && block.nested_group) {
      onChange({
        ...block,
        nested_group: {
          ...block.nested_group,
          children,
        },
      });
    }
  }, [block, onChange]);
  
  // Render based on block type
  if (block.type === 'group' || block.type === 'not') {
    // Handle both group and NOT blocks with unified logic
    const isNotBlock = block.type === 'not';
    const notBlock = isNotBlock ? (block as ASTNotNode) : null;
    const groupBlock = isNotBlock 
      ? (notBlock?.child.type === 'group' ? (notBlock.child as GroupNode) : null)
      : (block as GroupNode);
    
    // If NOT doesn't contain a group, fall through to regular rendering
    if (isNotBlock && !groupBlock) {
      const notBlockFallback = block as ASTNotNode;
      return (
        <>
          <QueryBlockCard
            canRemove={canRemove}
            readOnly={readOnly}
            onRemove={onRemove}
          >
            <span className="query-block-card__label">NOT</span>
          </QueryBlockCard>
          
          <div className="query-block-builder__nested-body">
            <QueryBlockBuilder
              block={notBlockFallback.child}
              onChange={handleNotChildChange}
              onRemove={() => {}}
              readOnly={isReadOnly}
            />
          </div>
        </>
      );
    }
    
    if (!groupBlock) return null;
    
    const logicOptions = [
      { value: 'AND', icon: "mdi mdi-set-all", label: 'All conditions must match (AND)' },
      { value: 'OR', icon: "mdi mdi-set-none", label: 'Any condition can match (OR)' },
      { value: 'NOT', icon: "mdi mdi-close-circle-outline", label: 'Exclude matches (NOT)' },
    ];
    
    const currentLogic = isNotBlock ? 'NOT' : groupBlock.logic;
    
    const handleUnifiedLogicChange = (newLogic: string) => {
      if (isNotBlock) {
        // NOT block changing logic
        if (newLogic === 'NOT') return; // Already NOT
        // Unwrap to plain group
        onChange({
          ...groupBlock,
          logic: newLogic as LogicType,
        });
      } else {
        // Group changing logic
        if (newLogic === 'NOT') {
          // Wrap in NOT
          onChange({
            type: 'not',
            child: groupBlock,
          });
        } else {
          // Just change logic
          onChange({
            ...groupBlock,
            logic: newLogic as LogicType,
          });
        }
      }
    };
    
    const handleUnifiedChildrenChange = (children: Array<ConditionNode | GroupNode | ASTNotNode>) => {
      if (isNotBlock && notBlock) {
        handleNotChildChange({
          ...groupBlock,
          children,
        });
      } else {
        handleGroupChange(children);
      }
    };
    
    // Action button for logic selection
    const logicActionButton = !isReadOnly ? (
      <SelectionButton
        options={logicOptions}
        value={currentLogic}
        onChange={handleUnifiedLogicChange}
        size="sm"
        disabled={readOnly}
      />
    ) : undefined;
    
    return (
      <>
        {/* Unified header for AND/OR/NOT using QueryBlockCard */}
        <QueryBlockCard
          canRemove={canRemove}
          readOnly={readOnly}
          onRemove={onRemove}
          actionButton={logicActionButton}
        >
          <span className="query-block-card__label">{currentLogic}</span>
        </QueryBlockCard>
        
        {/* Children rendered below with vertical line */}
        {groupBlock.children.length > 0 && (
          <div className="query-block-builder__nested-body">
            <QueryBlockList
              blocks={groupBlock.children}
              onChange={handleUnifiedChildrenChange}
              readOnly={isReadOnly}
              showAddButton={true}
              showEmptyMessage={false}
            />
          </div>
        )}
        {/* Show add button when empty */}
        {groupBlock.children.length === 0 && !isReadOnly && (
          <div className="query-block-builder__nested-body">
            <QueryBlockList
              blocks={[]}
              onChange={handleUnifiedChildrenChange}
              readOnly={isReadOnly}
              showAddButton={true}
              showEmptyMessage={false}
            />
          </div>
        )}
      </>
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
    
    // Check if operator requires a value - if not, don't show nested group
    const operator = 'operator' in condition ? (condition as { operator?: string }).operator : undefined;
    if (operator && !operatorNeedsValue(condition.condition_type, operator)) {
      return false;
    }
    
    // For parent condition: only show nested group if static mode (parent_uuid/parent_uuids) is NOT set
    if (condition.condition_type === 'parent') {
      return !condition.parent_uuid && !condition.parent_uuids && !condition.parent_id;
    }
    
    // For child condition: only show nested group if static mode (child_uuids) is NOT set
    if (condition.condition_type === 'child') {
      return !condition.child_uuids && !condition.child_ids;
    }
    
    // For reference condition: only show nested group if static mode (target_uuid) is NOT set
    if (condition.condition_type === 'reference') {
      return !condition.target_uuid && !condition.target_id;
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
        {'nested_group' in condition && condition.nested_group && (
          <div className="query-block-builder__nested-body">
            <QueryBlockList
              blocks={condition.nested_group.children}
              onChange={handleNestedChange}
              readOnly={isReadOnly}
              showAddButton={false}
              showEmptyMessage={false}
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

