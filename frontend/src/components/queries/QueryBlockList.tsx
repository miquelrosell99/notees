/**
 * QueryBlockList Component
 * 
 * Renders an array of query blocks (conditions or groups) with ability to add new blocks.
 * Uses @dnd-kit for drag-and-drop with support for nesting into groups.
 */

import { useCallback, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { mdiChevronDown } from '@mdi/js';
import Icon from '@mdi/react';
import { Button } from '../core/Button';
import { DeleteIcon } from '../icons';
import { Card } from '../core/Card';
import { DragHandle } from '../dnd/DragHandle';
import { QueryBlockBuilder } from './QueryBlockBuilder';
import type { GroupNode, ConditionNode, NotNode as ASTNotNode } from '@/types/queryAST';
import { isSystemNode } from '@/types/queryAST';
import './QueryBlockList.css';

// ==================== Types ====================

type QueryBlock = ConditionNode | GroupNode | ASTNotNode;

interface QueryBlockListProps {
  /** Array of blocks to render */
  blocks: QueryBlock[];
  /** Parent group logic (AND/OR) - affects prose rendering */
  parentLogic?: 'AND' | 'OR';
  /** Callback when blocks array changes */
  onChange: (blocks: QueryBlock[]) => void;
  /** Whether this list is read-only */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

interface SortableBlockItemProps {
  block: QueryBlock;
  index: number;
  parentLogic: 'AND' | 'OR';
  isFirst: boolean;
  readOnly: boolean;
  onUpdate: (block: QueryBlock) => void;
  onRemove: () => void;
  isDraggedOver: boolean;
  dropPosition: 'before' | 'after' | 'inside';
}

// ==================== Sortable Block Item ====================

function SortableBlockItem({
  block,
  index,
  parentLogic,
  isFirst,
  readOnly,
  onUpdate,
  onRemove,
  isDraggedOver,
  dropPosition,
}: SortableBlockItemProps) {
  // Check if this block is a system block (should not be dragged/deleted)
  const isSystem = isSystemNode(block);
  const effectiveReadOnly = readOnly || isSystem;
  
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `block-${index}`,
    disabled: isSystem, // Disable dragging for system blocks
    data: {
      type: 'query-block',
      block,
      index,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`query-block-list__item ${
        isDraggedOver ? `query-block-list__item--drag-over query-block-list__item--drag-${dropPosition}` : ''
      }`}
    >
      {/* Logic connector */}
      {!isFirst && (
        <span className="query-block-list__connector">
          {parentLogic.toLowerCase()}
        </span>
      )}

      {/* Block Card */}
      <Card
        className="query-block-list__card"
        elevation="low"
        variant="outlined"
        padding={false}
        radius="md"
      >
        {/* Drag handle - hide for system blocks */}
        {!effectiveReadOnly && (
          <div
            ref={setActivatorNodeRef}
            className="query-block-list__drag-handle"
            {...attributes}
            {...listeners}
          >
            <DragHandle visible />
          </div>
        )}

        {/* Block content */}
        <div className={`query-block-list__content ${effectiveReadOnly ? 'query-block-list__content--readonly' : ''}`}>
          <QueryBlockBuilder
            block={block}
            onChange={onUpdate}
            onRemove={onRemove}
            readOnly={effectiveReadOnly}
          />
        </div>

        {/* Delete button (hover only) - hide for system blocks */}
        {!effectiveReadOnly && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            title="Delete block and all children"
            className="query-block-list__delete"
          >
            <DeleteIcon size="md" />
          </Button>
        )}
      </Card>
    </div>
  );
}

// ==================== Main Component ====================

export function QueryBlockList({
  blocks,
  parentLogic = 'AND',
  onChange,
  readOnly = false,
  className = '',
}: QueryBlockListProps) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | 'inside'>('before');
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  // Update menu position when opened
  useEffect(() => {
    if (showAddMenu && addMenuRef.current) {
      const rect = addMenuRef.current.getBoundingClientRect();
      setMenuPosition({
        top: rect.bottom + window.scrollY + 4, // 4px gap
        left: rect.left + window.scrollX,
      });
    } else {
      setMenuPosition(null);
    }
  }, [showAddMenu]);

  // Close menu when clicking outside
  useEffect(() => {
    if (!showAddMenu) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedButton = addMenuRef.current && addMenuRef.current.contains(target);
      const clickedMenu = menuRef.current && menuRef.current.contains(target);
      
      if (!clickedButton && !clickedMenu) {
        setShowAddMenu(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showAddMenu]);

  // Add different block types
  const handleAddProperty = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'property',
      property_name: '',
      property_type: 'text',
      operator: '=',
      value: '',
    };
    onChange([...blocks, newCondition]);
    setShowAddMenu(false);
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
    setShowAddMenu(false);
  }, [blocks, onChange]);

  const handleAddClass = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'class',
      class_uuid: '',
      operator: 'contains',
    };
    onChange([...blocks, newCondition]);
    setShowAddMenu(false);
  }, [blocks, onChange]);

  const handleAddReference = useCallback(() => {
    const newCondition: ConditionNode = {
      type: 'condition',
      condition_type: 'reference',
      target_uuid: '',
    };
    onChange([...blocks, newCondition]);
    setShowAddMenu(false);
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
    setShowAddMenu(false);
  }, [blocks, onChange]);

  const handleAddGroup = useCallback(() => {
    const newGroup: GroupNode = {
      type: 'group',
      logic: 'AND',
      children: [],
    };
    onChange([...blocks, newGroup]);
    setShowAddMenu(false);
  }, [blocks, onChange]);

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

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id);
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over) return;

      setOverId(over.id);

      // Determine drop position based on pointer location
      const overId = over.id as string;
      const overIndex = parseInt(overId.split('-')[1]);
      const overBlock = blocks[overIndex];

      if (overBlock && overBlock.type === 'group') {
        // For groups, check if pointer is in middle zone (inside drop)
        const overRect = over.rect;
        if (overRect) {
          const pointerY = event.delta.y + overRect.top;
          const relativeY = pointerY - overRect.top;
          const height = overRect.height;

          if (relativeY > height * 0.3 && relativeY < height * 0.7) {
            setDropPosition('inside');
            return;
          }
        }
      }

      // Default to before/after
      const activeIndex = parseInt((active.id as string).split('-')[1]);
      setDropPosition(activeIndex < overIndex ? 'after' : 'before');
    },
    [blocks]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      setActiveId(null);
      setOverId(null);

      if (!over || active.id === over.id) return;

      const activeIndex = parseInt((active.id as string).split('-')[1]);
      const overIndex = parseInt((over.id as string).split('-')[1]);

      if (activeIndex === overIndex) return;

      const newBlocks = [...blocks];
      const [movedBlock] = newBlocks.splice(activeIndex, 1);
      const targetBlock = blocks[overIndex];

      // Handle drop inside group
      if (dropPosition === 'inside' && targetBlock.type === 'group') {
        const adjustedOverIndex = activeIndex < overIndex ? overIndex - 1 : overIndex;
        newBlocks[adjustedOverIndex] = {
          ...targetBlock,
          children: [...targetBlock.children, movedBlock],
        } as GroupNode;
      } else {
        // Handle drop before/after
        let insertIndex = activeIndex < overIndex ? overIndex : overIndex;
        if (dropPosition === 'after' && activeIndex > overIndex) {
          insertIndex++;
        }
        newBlocks.splice(insertIndex, 0, movedBlock);
      }

      onChange(newBlocks);
    },
    [blocks, dropPosition, onChange]
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setOverId(null);
  }, []);

  // Safety check for blocks array
  const safeBlocks = Array.isArray(blocks) ? blocks : [];
  const itemIds = safeBlocks.map((_, index) => `block-${index}`);

  return (
    <div className={`query-block-list ${className}`}>
      {/* Empty state */}
      {safeBlocks.length === 0 && (
        <div className="query-block-list__empty">
          {!readOnly ? (
            <div className="query-block-list__add-menu" ref={addMenuRef}>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => setShowAddMenu(!showAddMenu)}
              >
                + Add block
                <Icon path={mdiChevronDown} size={0.7} />
              </Button>
              {showAddMenu && (
                <Card className="query-block-list__add-menu-dropdown" elevation="high">
                  <div className="query-block-list__add-menu-item" onClick={handleAddProperty}>
                    Property
                  </div>
                  <div className="query-block-list__add-menu-item" onClick={handleAddContent}>
                    Content
                  </div>
                  <div className="query-block-list__add-menu-item" onClick={handleAddClass}>
                    Class
                  </div>
                  <div className="query-block-list__add-menu-item" onClick={handleAddReference}>
                    Reference
                  </div>
                  <div className="query-block-list__add-menu-item" onClick={handleAddParent}>
                    Parent
                  </div>
                  <div className="query-block-list__add-menu-item" onClick={handleAddGroup}>
                    Group
                  </div>
                </Card>
              )}
            </div>
          ) : (
            <p className="query-block-list__empty-message">
              No filters — all nodes will be shown
            </p>
          )}
        </div>
      )}

      {/* Sortable blocks */}
      {safeBlocks.length > 0 && !readOnly && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            {safeBlocks.map((block, index) => (
              <SortableBlockItem
                key={`block-${index}`}
                block={block}
                index={index}
                parentLogic={parentLogic}
                isFirst={index === 0}
                readOnly={readOnly}
                onUpdate={(updated) => handleUpdateBlock(index, updated)}
                onRemove={() => handleRemoveBlock(index)}
                isDraggedOver={overId === `block-${index}`}
                dropPosition={dropPosition}
              />
            ))}
          </SortableContext>

          <DragOverlay>
            {activeId ? (
              <div className="query-block-list__drag-overlay">
                Dragging block...
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* Read-only blocks */}
      {safeBlocks.length > 0 && readOnly && (
        <>
          {safeBlocks.map((block, index) => (
            <div key={index} className="query-block-list__item">
              {index > 0 && (
                <span className="query-block-list__connector">
                  {parentLogic.toLowerCase()}
                </span>
              )}
              <Card
                className="query-block-list__card"
                elevation="low"
                variant="outlined"
                padding={false}
                radius="md"
              >
                <div className="query-block-list__content query-block-list__content--readonly">
                  <QueryBlockBuilder
                    block={block}
                    onChange={() => {}}
                    onRemove={() => {}}
                    readOnly
                  />
                </div>
              </Card>
            </div>
          ))}
        </>
      )}

      {/* Add filter button */}
      {!readOnly && safeBlocks.length > 0 && (
        <div className="query-block-list__add" ref={addMenuRef}>
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => setShowAddMenu(!showAddMenu)}
          >
            + Add filter
            <Icon path={mdiChevronDown} size={0.7} />
          </Button>
          {showAddMenu && menuPosition && createPortal(
            <Card 
              ref={menuRef}
              className="query-block-list__add-menu-dropdown query-block-list__add-menu-dropdown--portal" 
              elevation="high"
              style={{
                position: 'absolute',
                top: `${menuPosition.top}px`,
                left: `${menuPosition.left}px`,
              }}
            >
              <div className="query-block-list__add-menu-item" onClick={handleAddProperty}>
                Property
              </div>
              <div className="query-block-list__add-menu-item" onClick={handleAddContent}>
                Content
              </div>
              <div className="query-block-list__add-menu-item" onClick={handleAddClass}>
                Class
              </div>
              <div className="query-block-list__add-menu-item" onClick={handleAddReference}>
                Reference
              </div>
              <div className="query-block-list__add-menu-item" onClick={handleAddParent}>
                Parent
              </div>
              <div className="query-block-list__add-menu-item" onClick={handleAddGroup}>
                Group
              </div>
            </Card>,
            document.body
          )}
        </div>
      )}
    </div>
  );
}

export default QueryBlockList;
