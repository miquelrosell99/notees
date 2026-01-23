/**
 * QueryBlockBuilder Component
 * 
 * UI component for building and editing query block trees.
 * Uses Card and Button components from core.
 */
import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import {
  mdiPlus,
  mdiDelete,
  mdiChevronDown,
  mdiChevronRight,
  mdiMagnify,
  mdiTagOutline,
  mdiTextBox,
  mdiLink,
  mdiArrowUp,
  mdiCodeBraces,
  mdiSetAll,
  mdiSetCenter,
  mdiCancel,
} from '@mdi/js';
import Icon from '@mdi/react';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import type {
  QueryBlock,
  QueryBlockTree,
  QueryBlockType,
  ContainerBlock,
  TypeBlock,
  PropertyBlock,
  ContentBlock,
  ReferenceBlock,
  AncestorPathBlock,
  PropertyOperator,
  ContentOperator,
  PropertyType,
} from '@/types/query';
import {
  getBlockTypeLabel,
  getOperatorLabel,
  createEmptyBlockTree,
} from '@/types/query';
import './QueryBlockBuilder.css';

// ==================== Types ====================

interface QueryBlockBuilderProps {
  /** The query block tree to edit */
  blockTree: QueryBlockTree;
  /** Callback when the block tree changes */
  onChange: (tree: QueryBlockTree) => void;
  /** Whether the builder is read-only */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

interface BlockEditorProps {
  block: QueryBlock;
  onUpdate: (block: QueryBlock) => void;
  onDelete: () => void;
  readOnly?: boolean;
  depth?: number;
}

interface AddBlockMenuProps {
  onSelect: (type: QueryBlockType) => void;
  trigger: ReactNode;
}

// ==================== Block Type Options ====================

const BLOCK_TYPE_OPTIONS: { value: QueryBlockType; label: string; icon: string }[] = [
  { value: 'AND_CONTAINER', label: 'All of (AND)', icon: mdiSetAll },
  { value: 'OR_CONTAINER', label: 'Any of (OR)', icon: mdiSetCenter },
  { value: 'NOT_CONTAINER', label: 'Not', icon: mdiCancel },
  { value: 'TYPE', label: 'Type', icon: mdiTagOutline },
  { value: 'PROPERTY', label: 'Property', icon: mdiCodeBraces },
  { value: 'CONTENT', label: 'Content', icon: mdiTextBox },
  { value: 'REFERENCE', label: 'References', icon: mdiLink },
  { value: 'ANCESTOR_PATH', label: 'Inside', icon: mdiArrowUp },
];

const PROPERTY_OPERATORS: PropertyOperator[] = [
  '=', '!=', '>', '>=', '<', '<=',
  'contains', 'starts_with', 'ends_with',
  'is_empty', 'is_not_empty',
];

const CONTENT_OPERATORS: ContentOperator[] = [
  'contains', '=', 'starts_with', 'ends_with', 'fts',
];

const PROPERTY_TYPES: { value: PropertyType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'integer', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'selection', label: 'Selection' },
  { value: 'node', label: 'Node' },
  { value: 'date', label: 'Date' },
];

// ==================== Helper Functions ====================

function createDefaultBlock(type: QueryBlockType): QueryBlock {
  switch (type) {
    case 'AND_CONTAINER':
    case 'OR_CONTAINER':
      return { type, blocks: [] };
    case 'NOT_CONTAINER':
      return { type, block: undefined };
    case 'TYPE':
      return { type, value: '' };
    case 'PROPERTY':
      return {
        type,
        property_name: '',
        property_type: 'text',
        operator: '=',
        value: '',
      };
    case 'CONTENT':
      return { type, operator: 'contains', value: '' };
    case 'REFERENCE':
      return { type, target_uuid: '{current_node_uuid}' };
    case 'REFERENCE_PATH':
      return { type, blocks: [] };
    case 'ANCESTOR_PATH':
      return { type, blocks: [] };
    case 'UUID':
      return { type, value: '' };
    default:
      return { type: 'AND_CONTAINER', blocks: [] };
  }
}

function getBlockIcon(type: QueryBlockType): string {
  const option = BLOCK_TYPE_OPTIONS.find(o => o.value === type);
  return option?.icon ?? mdiMagnify;
}

// ==================== AddBlockMenu ====================

function AddBlockMenu({ onSelect, trigger }: AddBlockMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current && 
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current && 
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const handleSelect = (type: QueryBlockType) => {
    onSelect(type);
    setIsOpen(false);
  };

  return (
    <div className="add-block-menu">
      <div ref={triggerRef} onClick={() => setIsOpen(!isOpen)}>
        {trigger}
      </div>
      {isOpen && (
        <Card
          ref={menuRef}
          variant="filled"
          padding={true}
          paddingSize="sm"
          radius="md"
          className="add-block-menu__dropdown"
        >
          {BLOCK_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="add-block-menu__item"
              onClick={() => handleSelect(opt.value)}
            >
              <Icon path={opt.icon} size={0.7} />
              <span>{opt.label}</span>
            </button>
          ))}
        </Card>
      )}
    </div>
  );
}

// ==================== Sub-Components ====================

/** Editor for Type blocks */
function TypeBlockEditor({
  block,
  onUpdate,
  readOnly,
}: {
  block: TypeBlock;
  onUpdate: (block: TypeBlock) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="block-editor__field">
      <label>Type name or UUID</label>
      <input
        type="text"
        value={block.value}
        onChange={(e) => onUpdate({ ...block, value: e.target.value })}
        placeholder="e.g., task, meeting, project"
        disabled={readOnly}
        className="block-editor__input"
      />
    </div>
  );
}

/** Editor for Property blocks */
function PropertyBlockEditor({
  block,
  onUpdate,
  readOnly,
}: {
  block: PropertyBlock;
  onUpdate: (block: PropertyBlock) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="block-editor__fields">
      <div className="block-editor__field">
        <label>Property</label>
        <input
          type="text"
          value={block.property_name}
          onChange={(e) => onUpdate({ ...block, property_name: e.target.value })}
          placeholder="Property name"
          disabled={readOnly}
          className="block-editor__input"
        />
      </div>
      <div className="block-editor__field block-editor__field--small">
        <label>Type</label>
        <select
          value={block.property_type}
          onChange={(e) => onUpdate({ ...block, property_type: e.target.value as PropertyType })}
          disabled={readOnly}
          className="block-editor__select"
        >
          {PROPERTY_TYPES.map((pt) => (
            <option key={pt.value} value={pt.value}>{pt.label}</option>
          ))}
        </select>
      </div>
      <div className="block-editor__field block-editor__field--small">
        <label>Operator</label>
        <select
          value={block.operator}
          onChange={(e) => onUpdate({ ...block, operator: e.target.value as PropertyOperator })}
          disabled={readOnly}
          className="block-editor__select"
        >
          {PROPERTY_OPERATORS.map((op) => (
            <option key={op} value={op}>{getOperatorLabel(op)}</option>
          ))}
        </select>
      </div>
      {!['is_empty', 'is_not_empty'].includes(block.operator) && (
        <div className="block-editor__field">
          <label>Value</label>
          <input
            type={block.property_type === 'integer' || block.property_type === 'float' ? 'number' : 'text'}
            value={String(block.value ?? '')}
            onChange={(e) => onUpdate({ ...block, value: e.target.value })}
            placeholder="Value"
            disabled={readOnly}
            className="block-editor__input"
          />
        </div>
      )}
    </div>
  );
}

/** Editor for Content blocks */
function ContentBlockEditor({
  block,
  onUpdate,
  readOnly,
}: {
  block: ContentBlock;
  onUpdate: (block: ContentBlock) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="block-editor__fields">
      <div className="block-editor__field block-editor__field--small">
        <label>Operator</label>
        <select
          value={block.operator}
          onChange={(e) => onUpdate({ ...block, operator: e.target.value as ContentOperator })}
          disabled={readOnly}
          className="block-editor__select"
        >
          {CONTENT_OPERATORS.map((op) => (
            <option key={op} value={op}>{getOperatorLabel(op)}</option>
          ))}
        </select>
      </div>
      <div className="block-editor__field">
        <label>Text</label>
        <input
          type="text"
          value={block.value}
          onChange={(e) => onUpdate({ ...block, value: e.target.value })}
          placeholder="Search text"
          disabled={readOnly}
          className="block-editor__input"
        />
      </div>
      <div className="block-editor__field block-editor__field--checkbox">
        <label>
          <input
            type="checkbox"
            checked={block.case_sensitive ?? false}
            onChange={(e) => onUpdate({ ...block, case_sensitive: e.target.checked })}
            disabled={readOnly}
          />
          Case sensitive
        </label>
      </div>
    </div>
  );
}

/** Editor for Reference blocks */
function ReferenceBlockEditor({
  block,
  onUpdate,
  readOnly,
}: {
  block: ReferenceBlock;
  onUpdate: (block: ReferenceBlock) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="block-editor__field">
      <label>Target UUID (or placeholder)</label>
      <input
        type="text"
        value={block.target_uuid}
        onChange={(e) => onUpdate({ ...block, target_uuid: e.target.value })}
        placeholder="{current_node_uuid}"
        disabled={readOnly}
        className="block-editor__input"
      />
    </div>
  );
}

/** Editor for AncestorPath blocks */
function AncestorPathBlockEditor({
  block,
  onUpdate,
  readOnly,
}: {
  block: AncestorPathBlock;
  onUpdate: (block: AncestorPathBlock) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="block-editor__fields">
      <div className="block-editor__field block-editor__field--small">
        <label>Max depth</label>
        <input
          type="number"
          value={block.max_depth ?? ''}
          onChange={(e) => onUpdate({
            ...block,
            max_depth: e.target.value ? parseInt(e.target.value, 10) : undefined,
          })}
          placeholder="∞"
          min={1}
          disabled={readOnly}
          className="block-editor__input"
        />
      </div>
    </div>
  );
}

// ==================== Block Editor ====================

function BlockEditor({
  block,
  onUpdate,
  onDelete,
  readOnly = false,
  depth = 0,
}: BlockEditorProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const hasNestedBlocks = 'blocks' in block && Array.isArray(block.blocks);

  const handleAddBlock = useCallback((type: QueryBlockType) => {
    if (!hasNestedBlocks) return;
    const container = block as ContainerBlock;
    onUpdate({
      ...container,
      blocks: [...container.blocks, createDefaultBlock(type)],
    });
  }, [block, onUpdate, hasNestedBlocks]);

  const handleUpdateNestedBlock = useCallback((index: number, updatedBlock: QueryBlock) => {
    if (!hasNestedBlocks) return;
    const container = block as ContainerBlock;
    const newBlocks = [...container.blocks];
    newBlocks[index] = updatedBlock;
    onUpdate({ ...container, blocks: newBlocks });
  }, [block, onUpdate, hasNestedBlocks]);

  const handleDeleteNestedBlock = useCallback((index: number) => {
    if (!hasNestedBlocks) return;
    const container = block as ContainerBlock;
    const newBlocks = container.blocks.filter((_, i) => i !== index);
    onUpdate({ ...container, blocks: newBlocks });
  }, [block, onUpdate, hasNestedBlocks]);

  const renderBlockContent = () => {
    switch (block.type) {
      case 'TYPE':
        return <TypeBlockEditor block={block} onUpdate={onUpdate as (b: TypeBlock) => void} readOnly={readOnly} />;
      case 'PROPERTY':
        return <PropertyBlockEditor block={block} onUpdate={onUpdate as (b: PropertyBlock) => void} readOnly={readOnly} />;
      case 'CONTENT':
        return <ContentBlockEditor block={block} onUpdate={onUpdate as (b: ContentBlock) => void} readOnly={readOnly} />;
      case 'REFERENCE':
        return <ReferenceBlockEditor block={block} onUpdate={onUpdate as (b: ReferenceBlock) => void} readOnly={readOnly} />;
      case 'ANCESTOR_PATH':
        return <AncestorPathBlockEditor block={block} onUpdate={onUpdate as (b: AncestorPathBlock) => void} readOnly={readOnly} />;
      default:
        return null;
    }
  };

  return (
    <Card
      variant="outlined"
      padding={true}
      paddingSize="sm"
      radius="sm"
      className={`block-editor block-editor--depth-${Math.min(depth, 3)} block-editor--${block.type.toLowerCase()}`}
    >
      <div className="block-editor__header">
        {hasNestedBlocks && (
          <Button
            icon={isCollapsed ? mdiChevronRight : mdiChevronDown}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={() => setIsCollapsed(!isCollapsed)}
          />
        )}
        <Icon path={getBlockIcon(block.type)} size={0.7} className="block-editor__type-icon" />
        <span className="block-editor__type-label">{getBlockTypeLabel(block.type)}</span>
        <div className="block-editor__spacer" />
        {!readOnly && (
          <Button
            icon={mdiDelete}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={onDelete}
            className="block-editor__delete-btn"
          />
        )}
      </div>

      {!isCollapsed && (
        <>
          <div className="block-editor__content">
            {renderBlockContent()}
          </div>

          {hasNestedBlocks && (
            <div className="block-editor__nested">
              {(block as ContainerBlock).blocks.map((nestedBlock, index) => (
                <BlockEditor
                  key={index}
                  block={nestedBlock}
                  onUpdate={(updated) => handleUpdateNestedBlock(index, updated)}
                  onDelete={() => handleDeleteNestedBlock(index)}
                  readOnly={readOnly}
                  depth={depth + 1}
                />
              ))}
              
              {!readOnly && (
                <div className="block-editor__add">
                  <AddBlockMenu
                    onSelect={handleAddBlock}
                    trigger={
                      <Button icon={mdiPlus} size="xs" variant="ghost">
                        Add condition
                      </Button>
                    }
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ==================== Main Component ====================

export function QueryBlockBuilder({
  blockTree,
  onChange,
  readOnly = false,
  className = '',
}: QueryBlockBuilderProps) {
  const handleAddRootBlock = useCallback((type: QueryBlockType) => {
    const newBlock = createDefaultBlock(type);
    onChange({
      ...blockTree,
      blocks: [...blockTree.blocks, newBlock],
    });
  }, [blockTree, onChange]);

  const handleClear = useCallback(() => {
    onChange(createEmptyBlockTree());
  }, [onChange]);

  return (
    <div className={`query-block-builder ${className}`}>
      <div className="query-block-builder__toolbar">
        <span className="query-block-builder__title">Query Builder</span>
        <div className="query-block-builder__spacer" />
        {!readOnly && blockTree.blocks.length > 0 && (
          <Button size="xs" variant="ghost" onClick={handleClear}>
            Clear all
          </Button>
        )}
      </div>

      <div className="query-block-builder__content">
        {blockTree.blocks.length === 0 ? (
          <div className="query-block-builder__empty">
            <p>No conditions. Click "Add condition" to start building your query.</p>
          </div>
        ) : (
          <div className="query-block-builder__blocks">
            {blockTree.blocks.map((block, index) => (
              <BlockEditor
                key={index}
                block={block}
                onUpdate={(updated) => {
                  const newBlocks = [...blockTree.blocks];
                  newBlocks[index] = updated;
                  onChange({ ...blockTree, blocks: newBlocks });
                }}
                onDelete={() => {
                  const newBlocks = blockTree.blocks.filter((_, i) => i !== index);
                  onChange({ ...blockTree, blocks: newBlocks });
                }}
                readOnly={readOnly}
              />
            ))}
          </div>
        )}

        {!readOnly && (
          <div className="query-block-builder__add-root">
            <AddBlockMenu
              onSelect={handleAddRootBlock}
              trigger={
                <Button icon={mdiPlus} size="sm" variant="default">
                  Add condition
                </Button>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default QueryBlockBuilder;
