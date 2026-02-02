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
import { SelectionButton } from '../core/SelectionButton';
import { DeleteIcon } from '../icons';
import { isSystemNode, isNodeRemovable, isNodeEditable } from '@/types/queryAST';
import type { GroupNode, ConditionNode, NotNode as ASTNotNode, LogicType } from '@/types/queryAST';
import { mdiSetAll, mdiSetNone, mdiCloseCircleOutline, mdiClose } from '@mdi/js';
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
  
  // Handle group logic change (including NOT which wraps the group)
  const handleLogicChange = useCallback((newLogic: string) => {
    if (block.type === 'group') {
      const groupBlock = block as GroupNode;
      
      if (newLogic === 'NOT') {
        // Wrap the current group in a NOT node
        const notNode: ASTNotNode = {
          type: 'not',
          child: groupBlock,
        };
        onChange(notNode);
      } else {
        // Just change the logic type
        onChange({
          ...groupBlock,
          logic: newLogic as LogicType,
        });
      }
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
  
  // Handle logic change for NOT blocks (unwrap to group)
  const handleNotLogicChange = useCallback((newLogic: string) => {
    if (block.type === 'not') {
      const notBlock = block as ASTNotNode;
      if (notBlock.child.type === 'group' && newLogic !== 'NOT') {
        // Unwrap the NOT and change to the selected logic
        const innerGroup = notBlock.child as GroupNode;
        onChange({
          ...innerGroup,
          logic: newLogic as LogicType,
        });
      }
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
          <div className="prose-condition-card">
            <div className="prose-condition-card__content">
              <span className="prose-condition-card__label">NOT</span>
            </div>
            
            {canRemove && !readOnly && (
              <Button
                variant="ghost"
                size="xs"
                onClick={onRemove}
                title="Remove NOT"
                className="prose-condition-card__corner-button"
                icon={mdiClose}
                iconOnly
              />
            )}
          </div>
          
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
      { value: 'AND', icon: mdiSetAll, label: 'All conditions must match (AND)' },
      { value: 'OR', icon: mdiSetNone, label: 'Any condition can match (OR)' },
      { value: 'NOT', icon: mdiCloseCircleOutline, label: 'Exclude matches (NOT)' },
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
    
    return (
      <>
        {/* Unified header for AND/OR/NOT */}
        <div className="prose-condition-card">
          <div className="prose-condition-card__content">
            <span className="prose-condition-card__label">{currentLogic}</span>
          </div>
          
          {/* SelectionButton on the right */}
          {!isReadOnly && (
            <SelectionButton
              className="prose-condition__selection-button"
              options={logicOptions}
              value={currentLogic}
              onChange={handleUnifiedLogicChange}
              size="sm"
              disabled={readOnly}
            />
          )}
          
          {/* Delete button in corner */}
          {canRemove && !readOnly && (
            <Button
              variant="ghost"
              size="xs"
              onClick={onRemove}
              title={`Remove ${currentLogic}`}
              className="prose-condition-card__corner-button"
              icon={mdiClose}
              iconOnly
            />
          )}
        </div>
        
        {/* Children rendered below with vertical line */}
        {groupBlock.children.length > 0 && (
          <div className="query-block-builder__nested-body">
            <QueryBlockList
              blocks={groupBlock.children}
              parentLogic={groupBlock.logic}
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
              parentLogic={groupBlock.logic}
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

export default QueryBlockBuilder;
