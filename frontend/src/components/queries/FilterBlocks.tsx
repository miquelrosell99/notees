/**
 * Filter Block Components
 * 
 * Individual filter block editors for each query block type.
 * Supports both static value selection and dynamic query mode for node-type blocks.
 */
import { useCallback, useMemo } from 'react';
import {
  mdiClose,
  mdiChevronUp,
  mdiChevronDown,
} from '@mdi/js';
import Icon from '@mdi/react';
import { Button } from '../core/Button';
import { SelectionButton } from '../core/SelectionButton';
import { NodeSelector, SingleNodeSelector } from './NodeSelectors';
import { AddFilterButton } from './AddFilterButton';
import {
  TYPE_OPERATORS,
  CONTENT_OPERATORS,
  PROPERTY_TEXT_OPERATORS,
  PROPERTY_NUMBER_OPERATORS,
  VALUE_MODE_OPTIONS,
  createDefaultBlock,
} from './constants';
import { useClasses, usePages } from '@/hooks';
import type { Node as AppNode } from '@/types';
import type {
  QueryBlock,
  QueryBlockType,
  ContainerBlock,
  TypeBlock,
  PropertyBlock,
  ContentBlock,
  ReferenceBlock,
  ReferencePathBlock,
  AncestorPathBlock,
  NotBlock,
  PropertyOperator,
  ContentOperator,
} from '@/types/query';

// ==================== Common Types ====================

export interface FilterBlockProps {
  block: QueryBlock;
  onUpdate: (block: QueryBlock) => void;
  onDelete: () => void;
  readOnly?: boolean;
  depth?: number;
  /** Index in parent's blocks array, for reordering */
  index?: number;
  /** Total number of siblings, for reordering */
  totalSiblings?: number;
  /** Callback to move block up */
  onMoveUp?: () => void;
  /** Callback to move block down */
  onMoveDown?: () => void;
}

// ==================== Filter Block Actions ====================

interface FilterBlockActionsProps {
  readOnly?: boolean;
  index?: number;
  totalSiblings?: number;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDelete: () => void;
}

function FilterBlockActions({ readOnly, index, totalSiblings, onMoveUp, onMoveDown, onDelete }: FilterBlockActionsProps) {
  if (readOnly) return null;
  
  const canMoveUp = index !== undefined && index > 0 && onMoveUp;
  const canMoveDown = index !== undefined && totalSiblings !== undefined && index < totalSiblings - 1 && onMoveDown;
  const showReorderButtons = onMoveUp || onMoveDown;
  
  return (
    <div className="filter-block__actions">
      {showReorderButtons && (
        <>
          <button
            type="button"
            className="filter-block__reorder-btn"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            title="Move up"
          >
            <Icon path={mdiChevronUp} size={0.6} />
          </button>
          <button
            type="button"
            className="filter-block__reorder-btn"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            title="Move down"
          >
            <Icon path={mdiChevronDown} size={0.6} />
          </button>
        </>
      )}
      <Button icon={mdiClose} iconOnly variant="ghost" size="xs" onClick={onDelete} className="filter-block__delete" />
    </div>
  );
}

// ==================== Dynamic Query Section ====================

interface DynamicQuerySectionProps {
  blocks: QueryBlock[];
  onUpdate: (blocks: QueryBlock[]) => void;
  readOnly?: boolean;
  depth: number;
}

function DynamicQuerySection({ blocks, onUpdate, readOnly, depth }: DynamicQuerySectionProps) {
  const handleAddBlock = useCallback((type: QueryBlockType) => {
    onUpdate([...blocks, createDefaultBlock(type)]);
  }, [blocks, onUpdate]);
  
  const handleUpdateBlock = useCallback((index: number, updated: QueryBlock) => {
    const newBlocks = [...blocks];
    newBlocks[index] = updated;
    onUpdate(newBlocks);
  }, [blocks, onUpdate]);
  
  const handleDeleteBlock = useCallback((index: number) => {
    onUpdate(blocks.filter((_, i) => i !== index));
  }, [blocks, onUpdate]);
  
  const handleMoveBlock = useCallback((fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= blocks.length) return;
    const newBlocks = [...blocks];
    const [moved] = newBlocks.splice(fromIndex, 1);
    newBlocks.splice(toIndex, 0, moved);
    onUpdate(newBlocks);
  }, [blocks, onUpdate]);
  
  return (
    <div className="filter-block__dynamic-query">
      <div className="filter-block__dynamic-query-hint">
        Pages matching these conditions:
      </div>
      {blocks.map((block, index) => (
        <FilterBlock
          key={index}
          block={block}
          onUpdate={(updated) => handleUpdateBlock(index, updated)}
          onDelete={() => handleDeleteBlock(index)}
          readOnly={readOnly}
          depth={depth + 1}
          index={index}
          totalSiblings={blocks.length}
          onMoveUp={() => handleMoveBlock(index, index - 1)}
          onMoveDown={() => handleMoveBlock(index, index + 1)}
        />
      ))}
      {!readOnly && (
        <AddFilterButton onSelect={handleAddBlock} />
      )}
    </div>
  );
}

// ==================== Class Filter Block ====================

export function ClassFilterBlock({ block, onUpdate, onDelete, readOnly, index, totalSiblings, onMoveUp, onMoveDown }: FilterBlockProps) {
  const classBlock = block as TypeBlock;  // TypeBlock from query schema still used internally
  const { data: classes } = useClasses();
  
  // Support multiple classes via comma-separated values
  const selectedClassIds = useMemo(() => {
    if (!classBlock.value || !classes) return [];
    const values = classBlock.value.split(',').map(v => v.trim());
    return classes.filter(c => values.includes(c.uuid) || values.includes(c.name)).map(c => c.id);
  }, [classBlock.value, classes]);
  
  const handleAddClass = useCallback((node: AppNode) => {
    const currentValues = classBlock.value ? classBlock.value.split(',').map(v => v.trim()).filter(Boolean) : [];
    if (!currentValues.includes(node.uuid)) {
      currentValues.push(node.uuid);
    }
    onUpdate({ ...classBlock, value: currentValues.join(','), type_id: node.id });
  }, [classBlock, onUpdate]);
  
  const handleRemoveClass = useCallback((nodeId: number) => {
    const cls = classes?.find(c => c.id === nodeId);
    if (!cls) return;
    const currentValues = classBlock.value ? classBlock.value.split(',').map(v => v.trim()).filter(Boolean) : [];
    const newValues = currentValues.filter(v => v !== cls.uuid && v !== cls.name);
    onUpdate({ ...classBlock, value: newValues.join(',') });
  }, [classBlock, classes, onUpdate]);
  
  return (
    <div className="filter-block filter-block--class">
      <div className="filter-block__field">
        <span className="filter-block__label">Classes</span>
      </div>
      <select className="filter-block__operator" disabled={readOnly}>
        {TYPE_OPERATORS.map(op => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>
      <div className="filter-block__value">
        <NodeSelector
          mode="classes"
          selectedIds={selectedClassIds}
          onAdd={handleAddClass}
          onRemove={handleRemoveClass}
          placeholder="Select classes..."
          readOnly={readOnly}
        />
      </div>
      <FilterBlockActions
        readOnly={readOnly}
        index={index}
        totalSiblings={totalSiblings}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onDelete={onDelete}
      />
    </div>
  );
}

// ==================== Content Filter Block ====================

export function ContentFilterBlock({ block, onUpdate, onDelete, readOnly, index, totalSiblings, onMoveUp, onMoveDown }: FilterBlockProps) {
  const contentBlock = block as ContentBlock;
  
  return (
    <div className="filter-block filter-block--content">
      <div className="filter-block__field">
        <span className="filter-block__label">Content</span>
      </div>
      <select
        className="filter-block__operator"
        value={contentBlock.operator}
        onChange={(e) => onUpdate({ ...contentBlock, operator: e.target.value as ContentOperator })}
        disabled={readOnly}
      >
        {CONTENT_OPERATORS.map(op => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>
      <div className="filter-block__value">
        <input
          type="text"
          className="filter-block__input"
          value={contentBlock.value}
          onChange={(e) => onUpdate({ ...contentBlock, value: e.target.value })}
          placeholder="Search text..."
          disabled={readOnly}
        />
      </div>
      <FilterBlockActions
        readOnly={readOnly}
        index={index}
        totalSiblings={totalSiblings}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onDelete={onDelete}
      />
    </div>
  );
}

// ==================== Reference Filter Block ====================

/**
 * ReferenceFilterBlock - Filter nodes that reference a specific page
 * Supports both static page selection and dynamic query mode.
 */
export function ReferenceFilterBlock({ block, onUpdate, onDelete, readOnly, depth = 0, index, totalSiblings, onMoveUp, onMoveDown }: FilterBlockProps) {
  const refBlock = block as ReferenceBlock;
  const { data: pages } = usePages();
  
  // Determine if we're in dynamic mode (has dynamic_blocks)
  const isDynamic = !!(refBlock as ReferenceBlock & { dynamic_blocks?: QueryBlock[] }).dynamic_blocks;
  const dynamicBlocks = (refBlock as ReferenceBlock & { dynamic_blocks?: QueryBlock[] }).dynamic_blocks ?? [];
  
  // Find selected page by UUID (for static mode)
  const selectedPageId = useMemo(() => {
    if (isDynamic || !refBlock.target_uuid || refBlock.target_uuid.startsWith('{')) return null;
    const page = pages?.find(p => p.uuid === refBlock.target_uuid);
    return page?.id ?? null;
  }, [isDynamic, refBlock.target_uuid, pages]);
  
  const handleSelectPage = useCallback((_nodeId: number | null, node?: AppNode) => {
    if (node) {
      onUpdate({ ...refBlock, target_uuid: node.uuid, target_id: node.id });
    } else {
      onUpdate({ ...refBlock, target_uuid: '', target_id: undefined });
    }
  }, [refBlock, onUpdate]);
  
  const handleModeChange = useCallback((mode: string) => {
    if (mode === 'dynamic') {
      // Switch to dynamic mode
      onUpdate({
        ...refBlock,
        target_uuid: '',
        target_id: undefined,
        dynamic_blocks: [],
      } as ReferenceBlock & { dynamic_blocks: QueryBlock[] });
    } else {
      // Switch to static mode
      const { dynamic_blocks: _, ...rest } = refBlock as ReferenceBlock & { dynamic_blocks?: QueryBlock[] };
      onUpdate(rest as ReferenceBlock);
    }
  }, [refBlock, onUpdate]);
  
  const handleDynamicBlocksUpdate = useCallback((blocks: QueryBlock[]) => {
    onUpdate({
      ...refBlock,
      dynamic_blocks: blocks,
    } as ReferenceBlock & { dynamic_blocks: QueryBlock[] });
  }, [refBlock, onUpdate]);
  
  // Check if using placeholder
  const isPlaceholder = refBlock.target_uuid?.startsWith('{');
  
  return (
    <div className="filter-block filter-block--reference">
      <div className="filter-block__field">
        <span className="filter-block__label">References</span>
      </div>
      <select className="filter-block__operator" disabled>
        <option value="references">to</option>
      </select>
      <div className="filter-block__value">
        {isPlaceholder ? (
          <div className="filter-block__placeholder-badge">
            <span>{refBlock.target_uuid === '{current_node_uuid}' ? 'Current Page' : refBlock.target_uuid}</span>
            {!readOnly && (
              <Button
                icon={mdiClose}
                iconOnly
                variant="ghost"
                size="xs"
                onClick={() => onUpdate({ ...refBlock, target_uuid: '' })}
              />
            )}
          </div>
        ) : isDynamic ? (
          <DynamicQuerySection
            blocks={dynamicBlocks}
            onUpdate={handleDynamicBlocksUpdate}
            readOnly={readOnly}
            depth={depth}
          />
        ) : (
          <SingleNodeSelector
            mode="pages"
            selectedId={selectedPageId}
            onChange={handleSelectPage}
            placeholder="Select page..."
            readOnly={readOnly}
          />
        )}
      </div>
      {!readOnly && !isPlaceholder && (
        <div className="filter-block__mode-toggle">
          <SelectionButton
            options={VALUE_MODE_OPTIONS}
            value={isDynamic ? 'dynamic' : 'static'}
            onChange={handleModeChange}
            size="sm"
          />
        </div>
      )}
      <FilterBlockActions
        readOnly={readOnly}
        index={index}
        totalSiblings={totalSiblings}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onDelete={onDelete}
      />
    </div>
  );
}

// ==================== Ancestor Path Filter Block ====================

/**
 * AncestorPathFilterBlock - Filter nodes by parent page
 * Supports both static page selection and dynamic query mode.
 */
export function AncestorPathFilterBlock({ block, onUpdate, onDelete, readOnly, depth = 0, index, totalSiblings, onMoveUp, onMoveDown }: FilterBlockProps) {
  const ancestorBlock = block as AncestorPathBlock;
  const { data: pages } = usePages();
  
  // Determine mode: dynamic if has blocks that aren't just UUID blocks
  const hasDynamicBlocks = ancestorBlock.blocks.length > 0 && 
    ancestorBlock.blocks.some(b => b.type !== 'UUID');
  const isDynamic = hasDynamicBlocks;
  
  // Extract page from nested blocks if it's a UUID block (static mode)
  const selectedPageId = useMemo(() => {
    if (isDynamic || ancestorBlock.blocks.length === 0) return null;
    const firstBlock = ancestorBlock.blocks[0];
    if (firstBlock.type === 'UUID') {
      const page = pages?.find(p => p.uuid === firstBlock.value);
      return page?.id ?? null;
    }
    return null;
  }, [isDynamic, ancestorBlock.blocks, pages]);
  
  const handleSelectPage = useCallback((_nodeId: number | null, node?: AppNode) => {
    if (node) {
      onUpdate({
        ...ancestorBlock,
        blocks: [{ type: 'UUID', value: node.uuid }],
      });
    } else {
      onUpdate({ ...ancestorBlock, blocks: [] });
    }
  }, [ancestorBlock, onUpdate]);
  
  const handleModeChange = useCallback((mode: string) => {
    if (mode === 'dynamic') {
      // Switch to dynamic mode - clear UUID blocks
      onUpdate({
        ...ancestorBlock,
        blocks: [],
      });
    } else {
      // Switch to static mode - clear all blocks
      onUpdate({
        ...ancestorBlock,
        blocks: [],
      });
    }
  }, [ancestorBlock, onUpdate]);
  
  const handleDynamicBlocksUpdate = useCallback((blocks: QueryBlock[]) => {
    onUpdate({
      ...ancestorBlock,
      blocks,
    });
  }, [ancestorBlock, onUpdate]);
  
  return (
    <div className="filter-block filter-block--ancestor">
      <div className="filter-block__field">
        <span className="filter-block__label">Inside page</span>
      </div>
      <select className="filter-block__operator" disabled>
        <option value="in">in</option>
      </select>
      <div className="filter-block__value">
        {isDynamic ? (
          <DynamicQuerySection
            blocks={ancestorBlock.blocks}
            onUpdate={handleDynamicBlocksUpdate}
            readOnly={readOnly}
            depth={depth}
          />
        ) : (
          <SingleNodeSelector
            mode="pages"
            selectedId={selectedPageId}
            onChange={handleSelectPage}
            placeholder="Select parent page..."
            readOnly={readOnly}
          />
        )}
      </div>
      {!readOnly && (
        <div className="filter-block__mode-toggle">
          <SelectionButton
            options={VALUE_MODE_OPTIONS}
            value={isDynamic ? 'dynamic' : 'static'}
            onChange={handleModeChange}
            size="sm"
          />
        </div>
      )}
      <FilterBlockActions
        readOnly={readOnly}
        index={index}
        totalSiblings={totalSiblings}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onDelete={onDelete}
      />
    </div>
  );
}

// ==================== Reference Path Filter Block ====================

/**
 * ReferencePathFilterBlock - Filter nodes that are referenced by nodes matching criteria
 * Supports both static page selection and dynamic query mode.
 */
export function ReferencePathFilterBlock({ block, onUpdate, onDelete, readOnly, depth = 0, index, totalSiblings, onMoveUp, onMoveDown }: FilterBlockProps) {
  const refPathBlock = block as ReferencePathBlock;
  const { data: pages } = usePages();
  
  // Determine mode: dynamic if has blocks that aren't just UUID blocks
  const hasDynamicBlocks = refPathBlock.blocks.length > 0 && 
    refPathBlock.blocks.some(b => b.type !== 'UUID');
  const isDynamic = hasDynamicBlocks;
  
  // Find selected page by UUID (for static mode - single UUID block)
  const selectedPageId = useMemo(() => {
    if (isDynamic || refPathBlock.blocks.length === 0) return null;
    const firstBlock = refPathBlock.blocks[0];
    if (firstBlock.type === 'UUID') {
      const page = pages?.find(p => p.uuid === firstBlock.value);
      return page?.id ?? null;
    }
    return null;
  }, [isDynamic, refPathBlock.blocks, pages]);
  
  const handleSelectPage = useCallback((_nodeId: number | null, node?: AppNode) => {
    if (node) {
      onUpdate({
        ...refPathBlock,
        blocks: [{ type: 'UUID', value: node.uuid }],
      });
    } else {
      onUpdate({ ...refPathBlock, blocks: [] });
    }
  }, [refPathBlock, onUpdate]);
  
  const handleModeChange = useCallback((mode: string) => {
    if (mode === 'dynamic') {
      // Switch to dynamic mode - clear UUID blocks
      onUpdate({
        ...refPathBlock,
        blocks: [],
      });
    } else {
      // Switch to static mode - clear all blocks
      onUpdate({
        ...refPathBlock,
        blocks: [],
      });
    }
  }, [refPathBlock, onUpdate]);
  
  const handleDynamicBlocksUpdate = useCallback((blocks: QueryBlock[]) => {
    onUpdate({
      ...refPathBlock,
      blocks,
    });
  }, [refPathBlock, onUpdate]);
  
  return (
    <div className="filter-block filter-block--reference-path">
      <div className="filter-block__field">
        <span className="filter-block__label">Path Refs</span>
      </div>
      <select className="filter-block__operator" disabled>
        <option value="from">from</option>
      </select>
      <div className="filter-block__value">
        {isDynamic ? (
          <DynamicQuerySection
            blocks={refPathBlock.blocks}
            onUpdate={handleDynamicBlocksUpdate}
            readOnly={readOnly}
            depth={depth}
          />
        ) : (
          <SingleNodeSelector
            mode="pages"
            selectedId={selectedPageId}
            onChange={handleSelectPage}
            placeholder="Select page..."
            readOnly={readOnly}
          />
        )}
      </div>
      {!readOnly && (
        <div className="filter-block__mode-toggle">
          <SelectionButton
            options={VALUE_MODE_OPTIONS}
            value={isDynamic ? 'dynamic' : 'static'}
            onChange={handleModeChange}
            size="sm"
          />
        </div>
      )}
      <FilterBlockActions
        readOnly={readOnly}
        index={index}
        totalSiblings={totalSiblings}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onDelete={onDelete}
      />
    </div>
  );
}

// ==================== Property Filter Block ====================

export function PropertyFilterBlock({ block, onUpdate, onDelete, readOnly, index, totalSiblings, onMoveUp, onMoveDown }: FilterBlockProps) {
  const propBlock = block as PropertyBlock;
  
  const operators = useMemo(() => {
    if (propBlock.property_type === 'integer' || propBlock.property_type === 'float') {
      return PROPERTY_NUMBER_OPERATORS;
    }
    return PROPERTY_TEXT_OPERATORS;
  }, [propBlock.property_type]);
  
  const showValue = !['is_empty', 'is_not_empty'].includes(propBlock.operator);
  
  return (
    <div className="filter-block filter-block--property">
      <div className="filter-block__field">
        <input
          type="text"
          className="filter-block__input filter-block__input--name"
          value={propBlock.property_name}
          onChange={(e) => onUpdate({ ...propBlock, property_name: e.target.value })}
          placeholder="Property"
          disabled={readOnly}
        />
      </div>
      <select
        className="filter-block__operator"
        value={propBlock.operator}
        onChange={(e) => onUpdate({ ...propBlock, operator: e.target.value as PropertyOperator })}
        disabled={readOnly}
      >
        {operators.map(op => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>
      <div className="filter-block__value">
        {showValue && (
          <input
            type={propBlock.property_type === 'integer' || propBlock.property_type === 'float' ? 'number' : 'text'}
            className="filter-block__input"
            value={String(propBlock.value ?? '')}
            onChange={(e) => onUpdate({ ...propBlock, value: e.target.value })}
            placeholder="Value"
            disabled={readOnly}
          />
        )}
      </div>
      <FilterBlockActions
        readOnly={readOnly}
        index={index}
        totalSiblings={totalSiblings}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onDelete={onDelete}
      />
    </div>
  );
}

// ==================== Container Filter Block ====================

export function ContainerFilterBlock({ block, onUpdate, onDelete, readOnly, depth = 0, index, totalSiblings, onMoveUp, onMoveDown }: FilterBlockProps) {
  const isNotBlock = block.type === 'NOT_CONTAINER';
  const containerBlock = block as ContainerBlock | NotBlock;
  const nestedBlocks = isNotBlock
    ? (containerBlock as NotBlock).block ? [(containerBlock as NotBlock).block!] : []
    : (containerBlock as ContainerBlock).blocks;
  
  const containerType = block.type as 'AND_CONTAINER' | 'OR_CONTAINER' | 'NOT_CONTAINER';
  const icon = containerType === 'AND_CONTAINER' ? mdiSetAll : containerType === 'OR_CONTAINER' ? mdiSetCenter : mdiCancel;
  const label = containerType === 'AND_CONTAINER' ? 'all' : containerType === 'OR_CONTAINER' ? 'any' : 'none';
  
  const handleAddNestedBlock = useCallback((type: QueryBlockType) => {
    const newBlock = createDefaultBlock(type);
    if (isNotBlock) {
      onUpdate({ ...containerBlock, block: newBlock } as NotBlock);
    } else {
      onUpdate({ ...containerBlock, blocks: [...nestedBlocks, newBlock] } as ContainerBlock);
    }
  }, [containerBlock, nestedBlocks, onUpdate, isNotBlock]);
  
  const handleUpdateNestedBlock = useCallback((idx: number, updated: QueryBlock) => {
    if (isNotBlock) {
      onUpdate({ ...containerBlock, block: updated } as NotBlock);
    } else {
      const newBlocks = [...nestedBlocks];
      newBlocks[idx] = updated;
      onUpdate({ ...containerBlock, blocks: newBlocks } as ContainerBlock);
    }
  }, [containerBlock, nestedBlocks, onUpdate, isNotBlock]);
  
  const handleDeleteNestedBlock = useCallback((idx: number) => {
    if (isNotBlock) {
      onUpdate({ ...containerBlock, block: undefined } as NotBlock);
    } else {
      const newBlocks = nestedBlocks.filter((_, i) => i !== idx);
      onUpdate({ ...containerBlock, blocks: newBlocks } as ContainerBlock);
    }
  }, [containerBlock, nestedBlocks, onUpdate, isNotBlock]);
  
  return (
    <div className={`filter-block filter-block--container filter-block--${containerType.toLowerCase()}`}>
      <div className="filter-block__row">
        <div className="filter-block__field">
          <span className="filter-block__label">{label}</span>
        </div>
        <span style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>of:</span>
        <div className="filter-block__spacer" />
        <FilterBlockActions
          readOnly={readOnly}
          index={index}
          totalSiblings={totalSiblings}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onDelete={onDelete}
        />
      </div>
      
      <div className="filter-block__nested">
        {nestedBlocks.map((nested, idx) => (
          <FilterBlock
            key={idx}
            block={nested}
            onUpdate={(updated) => handleUpdateNestedBlock(idx, updated)}
            onDelete={() => handleDeleteNestedBlock(idx)}
            readOnly={readOnly}
            depth={depth + 1}
            index={idx}
            totalSiblings={nestedBlocks.length}
            onMoveUp={() => {
              if (idx > 0 && !isNotBlock) {
                const newBlocks = [...nestedBlocks];
                [newBlocks[idx - 1], newBlocks[idx]] = [newBlocks[idx], newBlocks[idx - 1]];
                onUpdate({ ...containerBlock, blocks: newBlocks } as ContainerBlock);
              }
            }}
            onMoveDown={() => {
              if (idx < nestedBlocks.length - 1 && !isNotBlock) {
                const newBlocks = [...nestedBlocks];
                [newBlocks[idx], newBlocks[idx + 1]] = [newBlocks[idx + 1], newBlocks[idx]];
                onUpdate({ ...containerBlock, blocks: newBlocks } as ContainerBlock);
              }
            }}
          />
        ))}
        
        {!readOnly && (!isNotBlock || nestedBlocks.length === 0) && (
          <AddFilterButton onSelect={handleAddNestedBlock} />
        )}
      </div>
    </div>
  );
}

// ==================== Filter Block Router ====================

export function FilterBlock(props: FilterBlockProps) {
  const { block } = props;
  
  switch (block.type) {
    case 'TYPE':
      return <ClassFilterBlock {...props} />;
    case 'CONTENT':
      return <ContentFilterBlock {...props} />;
    case 'REFERENCE':
      return <ReferenceFilterBlock {...props} />;
    case 'REFERENCE_PATH':
      return <ReferencePathFilterBlock {...props} />;
    case 'ANCESTOR_PATH':
      return <AncestorPathFilterBlock {...props} />;
    case 'PROPERTY':
      return <PropertyFilterBlock {...props} />;
    case 'AND_CONTAINER':
    case 'OR_CONTAINER':
    case 'NOT_CONTAINER':
      return <ContainerFilterBlock {...props} />;
    default:
      // Fallback for unknown block types
      return (
        <div className="filter-block">
          <div className="filter-block__field">
            <span className="filter-block__label">Unknown: {block.type}</span>
          </div>
          <div className="filter-block__value" />
          {!props.readOnly && (
            <Button icon={mdiClose} iconOnly variant="ghost" size="xs" onClick={props.onDelete} />
          )}
        </div>
      );
  }
}
