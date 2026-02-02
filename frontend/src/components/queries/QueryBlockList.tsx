/**
 * QueryBlockList Component
 * 
 * Renders an array of query blocks (conditions or groups) with ability to add and delete blocks.
 */

import { useCallback } from 'react';
import { mdiPlus } from '@mdi/js';
import { ButtonWithPanel } from '../core/ButtonWithPanel';
import { QueryBlockBuilder } from './QueryBlockBuilder';
import { AddFilterMenu, type FilterMenuCategory } from './AddFilterMenu';
import type { GroupNode, ConditionNode, NotNode as ASTNotNode } from '@/types/queryAST';
import { isNodeEditable } from '@/types/queryAST';
import './QueryBlockList.css';

// ==================== Types ====================

type QueryBlock = ConditionNode | GroupNode | ASTNotNode;

interface QueryBlockListProps {
  /** Array of blocks to render */
  blocks: QueryBlock[];
  /** Callback when blocks array changes */
  onChange: (blocks: QueryBlock[]) => void;
  /** Whether this list is read-only */
  readOnly?: boolean;
  /** Whether to show the add filter button (default: true for top-level, false for nested) */
  showAddButton?: boolean;
  /** Whether to show empty state message (default: true) */
  showEmptyMessage?: boolean;
  /** Additional CSS class */
  className?: string;
}

interface BlockItemProps {
  block: QueryBlock;
  index: number;
  readOnly: boolean;
  onUpdate: (block: QueryBlock) => void;
  onRemove: () => void;
}

// ==================== Block Item ====================

function BlockItem({
  block,
  readOnly,
  onUpdate,
  onRemove,
}: BlockItemProps) {
  const canEdit = isNodeEditable(block);
  const effectiveReadOnly = readOnly || !canEdit;

  return (
    <div className="query-block-list__item">
      <QueryBlockBuilder
        block={block}
        onChange={onUpdate}
        onRemove={onRemove}
        readOnly={effectiveReadOnly}
      />
    </div>
  );
}

// ==================== Main Component ====================

export function QueryBlockList({
  blocks,
  onChange,
  readOnly = false,
  showAddButton = true,
  showEmptyMessage = true,
  className = '',
}: QueryBlockListProps) {

  // Add different block types
  const handleAddProperty = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'property',
      property_name: '',
      property_type: 'text',
      operator: 'equals',
      value: '',
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddContent = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'content',
      operator: 'contains',
      value: '',
      case_sensitive: false,
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddClass = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'class',
      class_uuid: '',
      operator: 'is',
    };
    onChange([...blocks, newCondition]);
  }, [blocks, onChange]);

  const handleAddReference = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'reference',
      target_uuid: '',
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddParent = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'parent',
      nested_group: {
        type: 'group',
        logic: 'AND',
        children: [],
      },
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddGroup = useCallback(() => {
    const newGroup: GroupNode = {
      type: 'group',
      logic: 'AND',
      children: [],
    };
    onChange([...blocks, newGroup]);
    
  }, [blocks, onChange]);

  const handleAddChild = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'child',
      nested_group: {
        type: 'group',
        logic: 'AND',
        children: [],
      },
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddChildPath = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'child_path',
      nested_group: {
        type: 'group',
        logic: 'AND',
        children: [],
      },
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddParentPath = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'parent_path',
      nested_group: {
        type: 'group',
        logic: 'AND',
        children: [],
      },
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddClassPath = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'class_path',
      nested_group: {
        type: 'group',
        logic: 'AND',
        children: [],
      },
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddReferencePath = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'reference_path',
      nested_group: {
        type: 'group',
        logic: 'AND',
        children: [],
      },
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);



  // Build menu categories
  const menuCategories: FilterMenuCategory[] = [
    {
      title: 'Content',
      icon: '',
      items: [
        {
          id: 'content',
          label: 'Content',
          description: 'Filter by node name or text',
          onClick: handleAddContent,
        },
        {
          id: 'property',
          label: 'Property',
          description: 'Filter by property values',
          onClick: handleAddProperty,
        },
      ],
    },
    {
      title: 'Classification',
      icon: '',
      items: [
        {
          id: 'class',
          label: 'Class',
          description: 'Filter by direct class',
          onClick: handleAddClass,
        },
        {
          id: 'class_path',
          label: 'Class path',
          description: 'Filter by inherited class',
          onClick: handleAddClassPath,
        },
      ],
    },
    {
      title: 'References',
      icon: '',
      items: [
        {
          id: 'reference',
          label: 'References',
          description: 'Filter by direct references',
          onClick: handleAddReference,
        },
        {
          id: 'reference_path',
          label: 'Reference path',
          description: 'Filter by transitive references',
          onClick: handleAddReferencePath,
        },
      ],
    },
    {
      title: 'Hierarchy',
      icon: '',
      items: [
        {
          id: 'parent',
          label: 'Parent',
          description: 'Filter by direct parent',
          onClick: handleAddParent,
        },
        {
          id: 'parent_path',
          label: 'Parent path',
          description: 'Filter by ancestors',
          onClick: handleAddParentPath,
        },
        {
          id: 'child',
          label: 'Child',
          description: 'Filter by direct children',
          onClick: handleAddChild,
        },
        {
          id: 'child_path',
          label: 'Child path',
          description: 'Filter by descendants',
          onClick: handleAddChildPath,
        },
      ],
    },
    {
      title: 'Advanced',
      icon: '',
      items: [
        {
          id: 'group',
          label: 'AND/OR/NOT',
          description: 'Add a logic group (AND/OR/NOT)',
          onClick: handleAddGroup,
        },
      ],
    },
  ];

  // Handle updating a specific block
  const handleUpdateBlock = useCallback(
    (index: number, updatedBlock: QueryBlock) => {
      const newBlocks = [...blocks];
      newBlocks[index] = updatedBlock;
      onChange(newBlocks);
    },
    [blocks, onChange]
  );

  // Handle removing a block
  const handleRemoveBlock = useCallback(
    (index: number) => {
      const newBlocks = blocks.filter((_, i) => i !== index);
      onChange(newBlocks);
    },
    [blocks, onChange]
  );

  // Safety check for blocks array
  const safeBlocks = Array.isArray(blocks) ? blocks : [];

  return (
    <div className={`query-block-list ${className}`}>
      {/* Empty state - only when no blocks, showing add button, and showEmptyMessage is true */}
      {safeBlocks.length === 0 && showAddButton && showEmptyMessage && (
        <div className="query-block-list__empty">
          <p className="query-block-list__empty-message">
            {readOnly ? 'No filters — all nodes will be shown' : 'Click "+ Add filter" to add conditions'}
          </p>
        </div>
      )}

      {/* Editable blocks - simple list without drag and drop */}
      {safeBlocks.length > 0 && !readOnly && (
        <>
          {safeBlocks.map((block, index) => (
            <BlockItem
              key={`block-${index}`}
              block={block}
              index={index}
              readOnly={readOnly}
              onUpdate={(updated) => handleUpdateBlock(index, updated)}
              onRemove={() => handleRemoveBlock(index)}
            />
          ))}
        </>
      )}

      {/* Read-only blocks */}
      {safeBlocks.length > 0 && readOnly && (
        <>
          {safeBlocks.map((block, index) => (
            <BlockItem
              key={`block-${index}`}
              block={block}
              index={index}
              readOnly={true}
              onUpdate={() => {}}
              onRemove={() => {}}
            />
          ))}
        </>
      )}

      {/* Inline add button for nested lists - always visible but subtle */}
      {!readOnly && !showAddButton && (
        <div className="query-block-list__inline-add">
          <ButtonWithPanel
            buttonText=""
            variant="ghost"
            size="sm"
            panelPosition="bottom"
            panelAlignment="start"
            panelWidth={280}
            panelMaxHeight={400}
            closeOnClickOutside={true}
            closeOnEscape={true}
            showCloseButton={false}
            usePortal={true}
            buttonProps={{
              icon: mdiPlus,
              iconOnly: true,
            }}
            panelClassName="query-block-list__add-menu-panel"
          >
            {(closePanel) => <AddFilterMenu categories={menuCategories} onItemClick={closePanel} />}
          </ButtonWithPanel>
        </div>
      )}

      {/* Add filter button */}
      {!readOnly && showAddButton && (
        <div className="query-block-list__add">
          <ButtonWithPanel
            buttonText=""
            variant="ghost"
            size="sm"
            panelPosition="bottom"
            panelAlignment="start"
            panelWidth={280}
            panelMaxHeight={400}
            closeOnClickOutside={true}
            closeOnEscape={true}
            showCloseButton={false}
            usePortal={true}
            buttonProps={{
              icon: mdiPlus,
              iconOnly: true,
            }}
            panelClassName="query-block-list__add-menu-panel"
          >
            {(closePanel) => <AddFilterMenu categories={menuCategories} onItemClick={closePanel} />}
          </ButtonWithPanel>
        </div>
      )}
    </div>
  );
}

export default QueryBlockList;
