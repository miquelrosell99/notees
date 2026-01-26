/**
 * ConditionGroupBlock Component
 * 
 * Renders a group of conditions with AND/OR logic, supporting arbitrary nesting.
 * Provides controls to add/remove groups and conditions.
 */

import { useCallback } from 'react';
import { mdiClose, mdiPlusBox, mdiSetAll, mdiSetCenter } from '@mdi/js';
import { Button } from '../core/Button';
import { SelectionButton } from '../core/SelectionButton';
import { Card } from '../core/Card';
import { ConditionBlock } from './ConditionBlock';
import { AddFilterButton } from './AddFilterButton';
import { createConditionFromType, addNestedGroup } from '@/lib/queryASTHelpers';
import type { GroupNode, ConditionNode, NotNode as ASTNotNode, LogicType } from '@/types/queryAST';
import './ConditionGroupBlock.css';

// ==================== Types ====================

interface ConditionGroupBlockProps {
  group: GroupNode;
  onUpdate: (group: GroupNode) => void;
  onDelete?: () => void;
  depth?: number;
  readOnly?: boolean;
  showLogicToggle?: boolean;
}

const LOGIC_OPTIONS = [
  { value: 'AND', label: 'Match ALL (AND)', icon: mdiSetAll },
  { value: 'OR', label: 'Match ANY (OR)', icon: mdiSetCenter },
];

// ==================== Main Component ====================

export function ConditionGroupBlock({
  group,
  onUpdate,
  onDelete,
  depth = 0,
  readOnly = false,
  showLogicToggle = true,
}: ConditionGroupBlockProps) {
  
  // Handle logic type change
  const handleLogicChange = useCallback((value: string) => {
    onUpdate({
      ...group,
      logic: value as LogicType,
    });
  }, [group, onUpdate]);
  
  // Handle adding a condition
  const handleAddCondition = useCallback((type: string) => {
    const newCondition = createConditionFromType(type);
    onUpdate({
      ...group,
      children: [...group.children, newCondition],
    });
  }, [group, onUpdate]);
  
  // Handle adding a nested group
  const handleAddGroup = useCallback(() => {
    onUpdate(addNestedGroup(group, group.logic));
  }, [group, onUpdate]);
  
  // Handle updating a child
  const handleUpdateChild = useCallback((index: number, child: ConditionNode | GroupNode | ASTNotNode) => {
    const newChildren = [...group.children];
    newChildren[index] = child;
    onUpdate({
      ...group,
      children: newChildren,
    });
  }, [group, onUpdate]);
  
  // Handle deleting a child
  const handleDeleteChild = useCallback((index: number) => {
    onUpdate({
      ...group,
      children: group.children.filter((_, i) => i !== index),
    });
  }, [group, onUpdate]);
  
  const isNested = depth > 0;
  const isEmpty = group.children.length === 0;
  
  return (
    <Card
      className={`condition-group ${isNested ? 'condition-group--nested' : 'condition-group--root'}`}
      variant={isNested ? 'outlined' : 'filled'}
      padding={false}
      radius="md"
      style={{ '--group-depth': depth } as React.CSSProperties}
    >
      {/* Group header */}
      <div className="condition-group__header">
        {showLogicToggle && (
          <SelectionButton
            options={LOGIC_OPTIONS}
            value={group.logic}
            onChange={handleLogicChange}
            size="md"
            disabled={readOnly}
          />
        )}
        
        <span className="condition-group__label">
          {isEmpty ? 'Empty group' : `${group.children.length} condition${group.children.length !== 1 ? 's' : ''}`}
        </span>
        
        <div className="condition-group__spacer" />
        
        {!readOnly && depth > 0 && onDelete && (
          <Button
            icon={mdiClose}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={onDelete}
            title="Remove group"
          />
        )}
      </div>
      
      {/* Group children */}
      <div className="condition-group__children">
        {isEmpty ? (
          <div className="condition-group__empty">
            <p>No conditions in this group</p>
          </div>
        ) : (
          group.children.map((child, index) => {
            if (child.type === 'group') {
              return (
                <ConditionGroupBlock
                  key={index}
                  group={child}
                  onUpdate={(updated) => handleUpdateChild(index, updated)}
                  onDelete={() => handleDeleteChild(index)}
                  depth={depth + 1}
                  readOnly={readOnly}
                />
              );
            } else if (child.type === 'not') {
              // NOT node rendering
              return (
                <div key={index} className="condition-group__not-wrapper">
                  <span className="condition-group__not-label">NOT</span>
                  {child.child.type === 'group' ? (
                    <ConditionGroupBlock
                      group={child.child}
                      onUpdate={(updated) => handleUpdateChild(index, { ...child, child: updated })}
                      onDelete={() => handleDeleteChild(index)}
                      depth={depth + 1}
                      readOnly={readOnly}
                      showLogicToggle={false}
                    />
                  ) : (
                    <ConditionBlock
                      condition={child.child}
                      onUpdate={(updated) => handleUpdateChild(index, { ...child, child: updated })}
                      onDelete={() => handleDeleteChild(index)}
                      readOnly={readOnly}
                    />
                  )}
                </div>
              );
            } else {
              // Regular condition
              return (
                <ConditionBlock
                  key={index}
                  condition={child}
                  onUpdate={(updated) => handleUpdateChild(index, updated)}
                  onDelete={() => handleDeleteChild(index)}
                  readOnly={readOnly}
                />
              );
            }          })
        )}
      </div>
      
      {/* Group footer with add buttons */}
      {!readOnly && (
        <div className="condition-group__footer">
          <AddFilterButton onSelect={handleAddCondition} />
          <Button
            icon={mdiPlusBox}
            size="sm"
            variant="ghost"
            onClick={handleAddGroup}
          >
            Add group
          </Button>
        </div>
      )}
    </Card>
  );
}

export default ConditionGroupBlock;