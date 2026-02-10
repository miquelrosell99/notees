/**
 * QueryBlockList Component
 * 
 * Renders an array of query blocks (conditions or groups) with ability to add and delete blocks.
 */

import { useCallback, useState } from 'react';
import { mdiPlus } from '@mdi/js';
import { Button } from '../core/Button';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import { QueryBlockBuilder } from './QueryBlockBuilder';
import type { GroupNode, ConditionNode, NotNode as ASTNotNode, StyleType } from '@/types/queryAST';
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
      operator: 'contains',
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
      operator: 'contains',
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
      parent_uuid: '',
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
      child_uuids: [],
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddChildPath = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'child_path',
      descendant_uuids: [],
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddParentPath = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'parent_path',
      ancestor_uuids: [],
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddClassPath = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'class_path',
      class_uuids: [],
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddReferencePath = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'reference_path',
      target_uuids: [],
    };
    onChange([...blocks, newCondition]);
    
  }, [blocks, onChange]);

  const handleAddStyle = useCallback((styleType: StyleType) => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'style',
      style_type: styleType,
      operator: 'contains',
    };
    onChange([...blocks, newCondition]);
  }, [blocks, onChange]);



  // State for context menu
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);

  // Build context menu items
  const contextMenuItems: ContextMenuItem[] = [
    {
      id: 'content',
      label: 'CONTENT',
      onClick: () => { handleAddContent(); setMenuPosition(null); },
    },
    {
      id: 'property',
      label: 'PROPERTY',
      onClick: () => { handleAddProperty(); setMenuPosition(null); },
    },
    { id: 'sep-1', label: '', separator: true },
    {
      id: 'class',
      label: 'CLASS',
      onClick: () => { handleAddClass(); setMenuPosition(null); },
    },
    {
      id: 'class_path',
      label: 'CLASS PATH',
      onClick: () => { handleAddClassPath(); setMenuPosition(null); },
    },
    { id: 'sep-2', label: '', separator: true },
    {
      id: 'reference',
      label: 'REFERENCE',
      onClick: () => { handleAddReference(); setMenuPosition(null); },
    },
    {
      id: 'reference_path',
      label: 'REFERENCE PATH',
      onClick: () => { handleAddReferencePath(); setMenuPosition(null); },
    },
    { id: 'sep-3', label: '', separator: true },
    {
      id: 'parent',
      label: 'PARENT',
      onClick: () => { handleAddParent(); setMenuPosition(null); },
    },
    {
      id: 'parent_path',
      label: 'PARENT PATH',
      onClick: () => { handleAddParentPath(); setMenuPosition(null); },
    },
    {
      id: 'child',
      label: 'CHILD',
      onClick: () => { handleAddChild(); setMenuPosition(null); },
    },
    {
      id: 'child_path',
      label: 'CHILD PATH',
      onClick: () => { handleAddChildPath(); setMenuPosition(null); },
    },
    { id: 'sep-4', label: '', separator: true },
    {
      id: 'style-bold',
      label: 'BOLD',
      onClick: () => { handleAddStyle('bold'); setMenuPosition(null); },
    },
    {
      id: 'style-italic',
      label: 'ITALIC',
      onClick: () => { handleAddStyle('italic'); setMenuPosition(null); },
    },
    {
      id: 'style-underline',
      label: 'UNDERLINE',
      onClick: () => { handleAddStyle('underline'); setMenuPosition(null); },
    },
    {
      id: 'style-strikethrough',
      label: 'STRIKETHROUGH',
      onClick: () => { handleAddStyle('strikethrough'); setMenuPosition(null); },
    },
    { id: 'sep-5', label: '', separator: true },
    {
      id: 'group',
      label: 'AND/OR/NOT',
      onClick: () => { handleAddGroup(); setMenuPosition(null); },
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
      {safeBlocks.length === 0 && showAddButton && showEmptyMessage && readOnly && (
        <div className="query-block-list__empty">
          <p className="query-block-list__empty-message">
            No filters — all nodes will be shown
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
          <Button
            icon={mdiPlus}
            iconOnly
            variant="ghost"
            size="sm"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenuPosition({ x: rect.left, y: rect.bottom + 4 });
            }}
          />
        </div>
      )}

      {/* Add filter button - show small button when there are blocks, big button when empty */}
      {!readOnly && showAddButton && safeBlocks.length > 0 && (
        <div className="query-block-list__add">
          <Button
            icon={mdiPlus}
            iconOnly
            variant="ghost"
            size="sm"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenuPosition({ x: rect.left, y: rect.bottom + 4 });
            }}
          />
        </div>
      )}

      {/* Big "Add condition" button when empty */}
      {!readOnly && showAddButton && safeBlocks.length === 0 && (
        <div className="query-block-list__empty-add">
          <Button
            icon={mdiPlus}
            variant="default"
            size="md"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenuPosition({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            Add condition
          </Button>
        </div>
      )}

      {/* Context menu for adding conditions */}
      {menuPosition && (
        <ContextMenu
          items={contextMenuItems}
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
        />
      )}
    </div>
  );
}

export default QueryBlockList;
