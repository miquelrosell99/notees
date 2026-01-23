/**
 * Filter Block Components
 * 
 * Individual filter block editors for each query block type.
 * Supports both static value selection and dynamic query mode for node-type blocks.
 */
import { useCallback, useMemo } from 'react';
import {
  mdiClose,
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
import { SelectionButton } from '../core/SelectionButton';
import { NodeSelector, SingleNodeSelector } from './NodeSelectors';
import { AddFilterButton } from './AddFilterButton';
import {
  TYPE_OPERATORS,
  CONTENT_OPERATORS,
  PROPERTY_TEXT_OPERATORS,
  PROPERTY_NUMBER_OPERATORS,
  PROPERTY_TYPES,
  VALUE_MODE_OPTIONS,
  createDefaultBlock,
} from './constants';
import { useTypes, usePages } from '@/hooks';
import type { Node as AppNode } from '@/types';
import type {
  QueryBlock,
  QueryBlockType,
  ContainerBlock,
  TypeBlock,
  PropertyBlock,
  ContentBlock,
  ReferenceBlock,
  AncestorPathBlock,
  NotBlock,
  PropertyOperator,
  ContentOperator,
  PropertyType,
} from '@/types/query';

// ==================== Common Types ====================

export interface FilterBlockProps {
  block: QueryBlock;
  onUpdate: (block: QueryBlock) => void;
  onDelete: () => void;
  readOnly?: boolean;
  depth?: number;
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
        />
      ))}
      {!readOnly && (
        <AddFilterButton onSelect={handleAddBlock} />
      )}
    </div>
  );
}

// ==================== Type Filter Block ====================

export function TypeFilterBlock({ block, onUpdate, onDelete, readOnly }: FilterBlockProps) {
  const typeBlock = block as TypeBlock;
  const { data: types } = useTypes();
  
  // Support multiple types via comma-separated values
  const selectedTypeIds = useMemo(() => {
    if (!typeBlock.value || !types) return [];
    const values = typeBlock.value.split(',').map(v => v.trim());
    return types.filter(t => values.includes(t.uuid) || values.includes(t.name)).map(t => t.id);
  }, [typeBlock.value, types]);
  
  const handleAddType = useCallback((node: AppNode) => {
    const currentValues = typeBlock.value ? typeBlock.value.split(',').map(v => v.trim()).filter(Boolean) : [];
    if (!currentValues.includes(node.uuid)) {
      currentValues.push(node.uuid);
    }
    onUpdate({ ...typeBlock, value: currentValues.join(','), type_id: node.id });
  }, [typeBlock, onUpdate]);
  
  const handleRemoveType = useCallback((nodeId: number) => {
    const type = types?.find(t => t.id === nodeId);
    if (!type) return;
    const currentValues = typeBlock.value ? typeBlock.value.split(',').map(v => v.trim()).filter(Boolean) : [];
    const newValues = currentValues.filter(v => v !== type.uuid && v !== type.name);
    onUpdate({ ...typeBlock, value: newValues.join(',') });
  }, [typeBlock, types, onUpdate]);
  
  return (
    <Card variant="outlined" padding={true} paddingSize="sm" radius="sm" className="filter-block filter-block--type">
      <div className="filter-block__header">
        <Icon path={mdiTagOutline} size={0.7} className="filter-block__icon" />
        <span className="filter-block__label">Type</span>
        <select className="filter-block__operator" disabled={readOnly}>
          {TYPE_OPERATORS.map(op => (
            <option key={op.value} value={op.value}>{op.label}</option>
          ))}
        </select>
        <div className="filter-block__spacer" />
        {!readOnly && (
          <Button icon={mdiClose} iconOnly variant="ghost" size="xs" onClick={onDelete} className="filter-block__delete" />
        )}
      </div>
      <div className="filter-block__value">
        <NodeSelector
          mode="types"
          selectedIds={selectedTypeIds}
          onAdd={handleAddType}
          onRemove={handleRemoveType}
          placeholder="Select types..."
          readOnly={readOnly}
        />
      </div>
    </Card>
  );
}

// ==================== Content Filter Block ====================

export function ContentFilterBlock({ block, onUpdate, onDelete, readOnly }: FilterBlockProps) {
  const contentBlock = block as ContentBlock;
  
  return (
    <Card variant="outlined" padding={true} paddingSize="sm" radius="sm" className="filter-block filter-block--content">
      <div className="filter-block__header">
        <Icon path={mdiTextBox} size={0.7} className="filter-block__icon" />
        <span className="filter-block__label">Content</span>
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
        <div className="filter-block__spacer" />
        {!readOnly && (
          <Button icon={mdiClose} iconOnly variant="ghost" size="xs" onClick={onDelete} className="filter-block__delete" />
        )}
      </div>
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
    </Card>
  );
}

// ==================== Reference Filter Block ====================

/**
 * ReferenceFilterBlock - Filter nodes that reference a specific page
 * Supports both static page selection and dynamic query mode.
 */
export function ReferenceFilterBlock({ block, onUpdate, onDelete, readOnly, depth = 0 }: FilterBlockProps) {
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
    <Card variant="outlined" padding={true} paddingSize="sm" radius="sm" className="filter-block filter-block--reference">
      <div className="filter-block__header">
        <Icon path={mdiLink} size={0.7} className="filter-block__icon" />
        <span className="filter-block__label">References</span>
        <div className="filter-block__spacer" />
        {!readOnly && !isPlaceholder && (
          <SelectionButton
            options={VALUE_MODE_OPTIONS}
            value={isDynamic ? 'dynamic' : 'static'}
            onChange={handleModeChange}
            size="sm"
          />
        )}
        {!readOnly && (
          <Button icon={mdiClose} iconOnly variant="ghost" size="xs" onClick={onDelete} className="filter-block__delete" />
        )}
      </div>
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
    </Card>
  );
}

// ==================== Ancestor Path Filter Block ====================

/**
 * AncestorPathFilterBlock - Filter nodes by parent page
 * Supports both static page selection and dynamic query mode.
 */
export function AncestorPathFilterBlock({ block, onUpdate, onDelete, readOnly, depth = 0 }: FilterBlockProps) {
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
    <Card variant="outlined" padding={true} paddingSize="sm" radius="sm" className="filter-block filter-block--ancestor">
      <div className="filter-block__header">
        <Icon path={mdiArrowUp} size={0.7} className="filter-block__icon" />
        <span className="filter-block__label">Inside page</span>
        <div className="filter-block__spacer" />
        {!readOnly && (
          <SelectionButton
            options={VALUE_MODE_OPTIONS}
            value={isDynamic ? 'dynamic' : 'static'}
            onChange={handleModeChange}
            size="sm"
          />
        )}
        {!readOnly && (
          <Button icon={mdiClose} iconOnly variant="ghost" size="xs" onClick={onDelete} className="filter-block__delete" />
        )}
      </div>
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
    </Card>
  );
}

// ==================== Property Filter Block ====================

export function PropertyFilterBlock({ block, onUpdate, onDelete, readOnly }: FilterBlockProps) {
  const propBlock = block as PropertyBlock;
  
  const operators = useMemo(() => {
    if (propBlock.property_type === 'integer' || propBlock.property_type === 'float') {
      return PROPERTY_NUMBER_OPERATORS;
    }
    return PROPERTY_TEXT_OPERATORS;
  }, [propBlock.property_type]);
  
  const showValue = !['is_empty', 'is_not_empty'].includes(propBlock.operator);
  
  return (
    <Card variant="outlined" padding={true} paddingSize="sm" radius="sm" className="filter-block filter-block--property">
      <div className="filter-block__header">
        <Icon path={mdiCodeBraces} size={0.7} className="filter-block__icon" />
        <span className="filter-block__label">Property</span>
        <div className="filter-block__spacer" />
        {!readOnly && (
          <Button icon={mdiClose} iconOnly variant="ghost" size="xs" onClick={onDelete} className="filter-block__delete" />
        )}
      </div>
      <div className="filter-block__row">
        <input
          type="text"
          className="filter-block__input filter-block__input--name"
          value={propBlock.property_name}
          onChange={(e) => onUpdate({ ...propBlock, property_name: e.target.value })}
          placeholder="Property name"
          disabled={readOnly}
        />
        <select
          className="filter-block__select"
          value={propBlock.property_type}
          onChange={(e) => onUpdate({ ...propBlock, property_type: e.target.value as PropertyType })}
          disabled={readOnly}
        >
          {PROPERTY_TYPES.map(pt => (
            <option key={pt.value} value={pt.value}>{pt.label}</option>
          ))}
        </select>
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
      </div>
      {showValue && (
        <div className="filter-block__value">
          <input
            type={propBlock.property_type === 'integer' || propBlock.property_type === 'float' ? 'number' : 'text'}
            className="filter-block__input"
            value={String(propBlock.value ?? '')}
            onChange={(e) => onUpdate({ ...propBlock, value: e.target.value })}
            placeholder="Value"
            disabled={readOnly}
          />
        </div>
      )}
    </Card>
  );
}

// ==================== Container Filter Block ====================

export function ContainerFilterBlock({ block, onUpdate, onDelete, readOnly, depth = 0 }: FilterBlockProps) {
  const isNotBlock = block.type === 'NOT_CONTAINER';
  const containerBlock = block as ContainerBlock | NotBlock;
  const nestedBlocks = isNotBlock
    ? (containerBlock as NotBlock).block ? [(containerBlock as NotBlock).block!] : []
    : (containerBlock as ContainerBlock).blocks;
  
  const containerType = block.type as 'AND_CONTAINER' | 'OR_CONTAINER' | 'NOT_CONTAINER';
  const icon = containerType === 'AND_CONTAINER' ? mdiSetAll : containerType === 'OR_CONTAINER' ? mdiSetCenter : mdiCancel;
  const label = containerType === 'AND_CONTAINER' ? 'All of' : containerType === 'OR_CONTAINER' ? 'Any of' : 'Exclude';
  
  const handleAddNestedBlock = useCallback((type: QueryBlockType) => {
    const newBlock = createDefaultBlock(type);
    if (isNotBlock) {
      onUpdate({ ...containerBlock, block: newBlock } as NotBlock);
    } else {
      onUpdate({ ...containerBlock, blocks: [...nestedBlocks, newBlock] } as ContainerBlock);
    }
  }, [containerBlock, nestedBlocks, onUpdate, isNotBlock]);
  
  const handleUpdateNestedBlock = useCallback((index: number, updated: QueryBlock) => {
    if (isNotBlock) {
      onUpdate({ ...containerBlock, block: updated } as NotBlock);
    } else {
      const newBlocks = [...nestedBlocks];
      newBlocks[index] = updated;
      onUpdate({ ...containerBlock, blocks: newBlocks } as ContainerBlock);
    }
  }, [containerBlock, nestedBlocks, onUpdate, isNotBlock]);
  
  const handleDeleteNestedBlock = useCallback((index: number) => {
    if (isNotBlock) {
      onUpdate({ ...containerBlock, block: undefined } as NotBlock);
    } else {
      const newBlocks = nestedBlocks.filter((_, i) => i !== index);
      onUpdate({ ...containerBlock, blocks: newBlocks } as ContainerBlock);
    }
  }, [containerBlock, nestedBlocks, onUpdate, isNotBlock]);
  
  return (
    <Card
      variant="outlined"
      padding={true}
      paddingSize="sm"
      radius="sm"
      className={`filter-block filter-block--container filter-block--${containerType.toLowerCase()}`}
    >
      <div className="filter-block__header">
        <Icon path={icon} size={0.7} className="filter-block__icon" />
        <span className="filter-block__label">{label}</span>
        <div className="filter-block__spacer" />
        {!readOnly && (
          <Button icon={mdiClose} iconOnly variant="ghost" size="xs" onClick={onDelete} className="filter-block__delete" />
        )}
      </div>
      
      <div className="filter-block__nested">
        {nestedBlocks.map((nested, index) => (
          <FilterBlock
            key={index}
            block={nested}
            onUpdate={(updated) => handleUpdateNestedBlock(index, updated)}
            onDelete={() => handleDeleteNestedBlock(index)}
            readOnly={readOnly}
            depth={depth + 1}
          />
        ))}
        
        {!readOnly && (!isNotBlock || nestedBlocks.length === 0) && (
          <AddFilterButton onSelect={handleAddNestedBlock} />
        )}
      </div>
    </Card>
  );
}

// ==================== Filter Block Router ====================

export function FilterBlock(props: FilterBlockProps) {
  const { block } = props;
  
  switch (block.type) {
    case 'TYPE':
      return <TypeFilterBlock {...props} />;
    case 'CONTENT':
      return <ContentFilterBlock {...props} />;
    case 'REFERENCE':
      return <ReferenceFilterBlock {...props} />;
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
        <Card variant="outlined" padding={true} paddingSize="sm" radius="sm" className="filter-block">
          <div className="filter-block__header">
            <span className="filter-block__label">Unknown: {block.type}</span>
            {!props.readOnly && (
              <Button icon={mdiClose} iconOnly variant="ghost" size="xs" onClick={props.onDelete} />
            )}
          </div>
        </Card>
      );
  }
}
