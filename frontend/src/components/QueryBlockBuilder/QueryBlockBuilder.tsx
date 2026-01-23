/**
 * QueryBlockBuilder Component
 * 
 * Odoo-style query builder UI with:
 * - Top-level AND/OR toggle using SelectionButton
 * - Filter rows with field → operator → value layout
 * - NodePicker for relational fields (types, references, pages)
 * - NodeTypePill for multi-value selections
 * - Card component for each query block
 * - X button to delete blocks
 * - System default queries are hidden, user queries add on top
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  mdiPlus,
  mdiClose,
  mdiChevronDown,
  mdiSetAll,
  mdiSetCenter,
  mdiTagOutline,
  mdiTextBox,
  mdiLink,
  mdiArrowUp,
  mdiCodeBraces,
  mdiCancel,
  mdiPageNextOutline,
} from '@mdi/js';
import Icon from '@mdi/react';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { SelectionButton, type SelectionButtonOption } from '../core/SelectionButton';
import { NodeTypePill } from '../NodeTypePill';
import { useTypes, usePages, useNode } from '@/hooks';
import type { Node as AppNode } from '@/types';
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
  NotBlock,
  PropertyOperator,
  ContentOperator,
  PropertyType,
} from '@/types/query';
import {
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

// ==================== Constants ====================

const ROOT_LOGIC_OPTIONS: SelectionButtonOption[] = [
  { value: 'AND_CONTAINER', icon: mdiSetAll, label: 'Match ALL conditions' },
  { value: 'OR_CONTAINER', icon: mdiSetCenter, label: 'Match ANY condition' },
];

interface FilterTypeOption {
  value: QueryBlockType;
  label: string;
  icon: string;
  description: string;
}

const FILTER_TYPE_OPTIONS: FilterTypeOption[] = [
  { value: 'TYPE', label: 'Type', icon: mdiTagOutline, description: 'Filter by node type' },
  { value: 'CONTENT', label: 'Content', icon: mdiTextBox, description: 'Filter by text content' },
  { value: 'REFERENCE', label: 'References', icon: mdiLink, description: 'Nodes that reference...' },
  { value: 'ANCESTOR_PATH', label: 'Inside page', icon: mdiArrowUp, description: 'Descendant of page' },
  { value: 'PROPERTY', label: 'Property', icon: mdiCodeBraces, description: 'Filter by property value' },
  { value: 'AND_CONTAINER', label: 'All of (AND)', icon: mdiSetAll, description: 'Match all nested conditions' },
  { value: 'OR_CONTAINER', label: 'Any of (OR)', icon: mdiSetCenter, description: 'Match any nested condition' },
  { value: 'NOT_CONTAINER', label: 'Exclude (NOT)', icon: mdiCancel, description: 'Exclude matching nodes' },
];

// Operators organized by category
const TYPE_OPERATORS = [
  { value: 'is', label: 'is' },
  { value: 'is_not', label: 'is not' },
  { value: 'is_any', label: 'is any of' },
];

const CONTENT_OPERATORS = [
  { value: 'contains', label: 'contains' },
  { value: '=', label: 'equals' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'fts', label: 'search (full-text)' },
];

const PROPERTY_TEXT_OPERATORS = [
  { value: '=', label: 'equals' },
  { value: '!=', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

const PROPERTY_NUMBER_OPERATORS = [
  { value: '=', label: 'equals' },
  { value: '!=', label: 'not equals' },
  { value: '>', label: 'greater than' },
  { value: '>=', label: 'greater or equal' },
  { value: '<', label: 'less than' },
  { value: '<=', label: 'less or equal' },
];

const PROPERTY_TYPES = [
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
      return { type, target_uuid: '' };
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

// ==================== Node Selector Component ====================

interface NodeSelectorProps {
  mode: 'types' | 'pages';
  selectedIds: number[];
  onAdd: (node: AppNode) => void;
  onRemove: (nodeId: number) => void;
  placeholder?: string;
  readOnly?: boolean;
}

function NodeSelector({ mode, selectedIds, onAdd, onRemove, placeholder, readOnly }: NodeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const { data: types } = useTypes();
  const { data: pages } = usePages();
  
  const allNodes = useMemo(() => {
    if (mode === 'types') return types ?? [];
    return pages ?? [];
  }, [mode, types, pages]);
  
  const selectedNodes = useMemo(() => {
    return allNodes.filter(n => selectedIds.includes(n.id));
  }, [allNodes, selectedIds]);
  
  const filteredNodes = useMemo(() => {
    const term = search.toLowerCase();
    return allNodes
      .filter(n => !selectedIds.includes(n.id))
      .filter(n => (n.name || '').toLowerCase().includes(term))
      .slice(0, 10);
  }, [allNodes, selectedIds, search]);
  
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);
  
  const handleSelect = (node: AppNode) => {
    onAdd(node);
    setSearch('');
    setIsOpen(false);
  };
  
  return (
    <div className="node-selector" ref={menuRef}>
      {/* Selected pills */}
      <div className="node-selector__pills">
        {selectedNodes.map(node => (
          <NodeTypePill
            key={node.id}
            typeNode={node}
            onRemove={readOnly ? undefined : () => onRemove(node.id)}
            readOnly={readOnly}
          />
        ))}
        
        {/* Add button / dropdown trigger */}
        {!readOnly && (
          <button
            type="button"
            className="node-selector__add-btn"
            onClick={() => setIsOpen(!isOpen)}
          >
            <Icon path={mdiPlus} size={0.6} />
            {selectedIds.length === 0 && <span>{placeholder || 'Select...'}</span>}
          </button>
        )}
      </div>
      
      {/* Dropdown */}
      {isOpen && (
        <Card
          variant="filled"
          padding={false}
          radius="md"
          elevation="high"
          className="node-selector__dropdown"
        >
          <div className="node-selector__search">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${mode}...`}
              className="node-selector__input"
            />
          </div>
          <div className="node-selector__list">
            {filteredNodes.length === 0 ? (
              <div className="node-selector__empty">No {mode} found</div>
            ) : (
              filteredNodes.map(node => (
                <button
                  key={node.id}
                  type="button"
                  className="node-selector__item"
                  onClick={() => handleSelect(node)}
                >
                  <Icon path={mode === 'types' ? mdiTagOutline : mdiPageNextOutline} size={0.6} />
                  <span>{node.name || 'Untitled'}</span>
                </button>
              ))
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

// ==================== Single Node Selector ====================

interface SingleNodeSelectorProps {
  mode: 'types' | 'pages';
  selectedId: number | null;
  onChange: (nodeId: number | null, node?: AppNode) => void;
  placeholder?: string;
  readOnly?: boolean;
}

function SingleNodeSelector({ mode, selectedId, onChange, placeholder, readOnly }: SingleNodeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const { data: types } = useTypes();
  const { data: pages } = usePages();
  const { data: selectedNode } = useNode(selectedId);
  
  const allNodes = useMemo(() => {
    if (mode === 'types') return types ?? [];
    return pages ?? [];
  }, [mode, types, pages]);
  
  const filteredNodes = useMemo(() => {
    const term = search.toLowerCase();
    return allNodes
      .filter(n => (n.name || '').toLowerCase().includes(term))
      .slice(0, 10);
  }, [allNodes, search]);
  
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);
  
  const handleSelect = (node: AppNode) => {
    onChange(node.id, node);
    setSearch('');
    setIsOpen(false);
  };
  
  const handleClear = () => {
    onChange(null);
  };
  
  return (
    <div className="single-node-selector" ref={menuRef}>
      {selectedNode ? (
        <div className="single-node-selector__selected">
          <NodeTypePill
            typeNode={selectedNode}
            onRemove={readOnly ? undefined : handleClear}
            readOnly={readOnly}
          />
        </div>
      ) : (
        <button
          type="button"
          className="single-node-selector__trigger"
          onClick={() => !readOnly && setIsOpen(!isOpen)}
          disabled={readOnly}
        >
          <span className="single-node-selector__placeholder">{placeholder || 'Select...'}</span>
          <Icon path={mdiChevronDown} size={0.6} />
        </button>
      )}
      
      {isOpen && (
        <Card
          variant="filled"
          padding={false}
          radius="md"
          elevation="high"
          className="single-node-selector__dropdown"
        >
          <div className="single-node-selector__search">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${mode}...`}
              className="single-node-selector__input"
            />
          </div>
          <div className="single-node-selector__list">
            {filteredNodes.length === 0 ? (
              <div className="single-node-selector__empty">No {mode} found</div>
            ) : (
              filteredNodes.map(node => (
                <button
                  key={node.id}
                  type="button"
                  className="single-node-selector__item"
                  onClick={() => handleSelect(node)}
                >
                  <Icon path={mode === 'types' ? mdiTagOutline : mdiPageNextOutline} size={0.6} />
                  <span>{node.name || 'Untitled'}</span>
                </button>
              ))
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

// ==================== Filter Block Editors ====================

interface FilterBlockProps {
  block: QueryBlock;
  onUpdate: (block: QueryBlock) => void;
  onDelete: () => void;
  readOnly?: boolean;
  depth?: number;
}

/** Type Filter Block - select types from dropdown */
function TypeFilterBlock({ block, onUpdate, onDelete, readOnly }: FilterBlockProps) {
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

/** Content Filter Block */
function ContentFilterBlock({ block, onUpdate, onDelete, readOnly }: FilterBlockProps) {
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

/** Reference Filter Block - select page to filter references */
function ReferenceFilterBlock({ block, onUpdate, onDelete, readOnly }: FilterBlockProps) {
  const refBlock = block as ReferenceBlock;
  const { data: pages } = usePages();
  
  // Find selected page by UUID
  const selectedPageId = useMemo(() => {
    if (!refBlock.target_uuid || refBlock.target_uuid.startsWith('{')) return null;
    const page = pages?.find(p => p.uuid === refBlock.target_uuid);
    return page?.id ?? null;
  }, [refBlock.target_uuid, pages]);
  
  const handleSelectPage = useCallback((_nodeId: number | null, node?: AppNode) => {
    if (node) {
      onUpdate({ ...refBlock, target_uuid: node.uuid, target_id: node.id });
    } else {
      onUpdate({ ...refBlock, target_uuid: '', target_id: undefined });
    }
  }, [refBlock, onUpdate]);
  
  // Check if using placeholder
  const isPlaceholder = refBlock.target_uuid.startsWith('{');
  
  return (
    <Card variant="outlined" padding={true} paddingSize="sm" radius="sm" className="filter-block filter-block--reference">
      <div className="filter-block__header">
        <Icon path={mdiLink} size={0.7} className="filter-block__icon" />
        <span className="filter-block__label">References</span>
        <div className="filter-block__spacer" />
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

/** Ancestor Path Filter Block */
function AncestorPathFilterBlock({ block, onUpdate, onDelete, readOnly }: FilterBlockProps) {
  const ancestorBlock = block as AncestorPathBlock;
  const { data: pages } = usePages();
  
  // Extract page from nested blocks if it's a UUID block
  const selectedPageId = useMemo(() => {
    if (ancestorBlock.blocks.length === 0) return null;
    const firstBlock = ancestorBlock.blocks[0];
    if (firstBlock.type === 'UUID') {
      const page = pages?.find(p => p.uuid === firstBlock.value);
      return page?.id ?? null;
    }
    return null;
  }, [ancestorBlock.blocks, pages]);
  
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
  
  return (
    <Card variant="outlined" padding={true} paddingSize="sm" radius="sm" className="filter-block filter-block--ancestor">
      <div className="filter-block__header">
        <Icon path={mdiArrowUp} size={0.7} className="filter-block__icon" />
        <span className="filter-block__label">Inside page</span>
        <div className="filter-block__spacer" />
        {!readOnly && (
          <Button icon={mdiClose} iconOnly variant="ghost" size="xs" onClick={onDelete} className="filter-block__delete" />
        )}
      </div>
      <div className="filter-block__value">
        <SingleNodeSelector
          mode="pages"
          selectedId={selectedPageId}
          onChange={handleSelectPage}
          placeholder="Select parent page..."
          readOnly={readOnly}
        />
      </div>
    </Card>
  );
}

/** Property Filter Block */
function PropertyFilterBlock({ block, onUpdate, onDelete, readOnly }: FilterBlockProps) {
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

/** Container Block (AND/OR/NOT) - supports nested blocks */
function ContainerFilterBlock({ block, onUpdate, onDelete, readOnly, depth = 0 }: FilterBlockProps) {
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

function FilterBlock(props: FilterBlockProps) {
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

// ==================== Add Filter Button ====================

interface AddFilterButtonProps {
  onSelect: (type: QueryBlockType) => void;
}

function AddFilterButton({ onSelect }: AddFilterButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  
  const handleSelect = (type: QueryBlockType) => {
    onSelect(type);
    setIsOpen(false);
  };
  
  return (
    <div className="add-filter" ref={menuRef}>
      <Button
        icon={mdiPlus}
        size="sm"
        variant="ghost"
        onClick={() => setIsOpen(!isOpen)}
      >
        Add filter
      </Button>
      
      {isOpen && (
        <Card variant="filled" padding={false} radius="md" elevation="high" className="add-filter__menu">
          {FILTER_TYPE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              className="add-filter__item"
              onClick={() => handleSelect(opt.value)}
            >
              <Icon path={opt.icon} size={0.7} />
              <div className="add-filter__item-text">
                <span className="add-filter__item-label">{opt.label}</span>
                <span className="add-filter__item-desc">{opt.description}</span>
              </div>
            </button>
          ))}
        </Card>
      )}
    </div>
  );
}

// ==================== Main Component ====================

export function QueryBlockBuilder({
  blockTree,
  onChange,
  readOnly = false,
  className = '',
}: QueryBlockBuilderProps) {
  
  const handleRootTypeChange = useCallback((newType: string) => {
    onChange({
      ...blockTree,
      type: newType as 'AND_CONTAINER' | 'OR_CONTAINER',
    });
  }, [blockTree, onChange]);
  
  const handleAddBlock = useCallback((type: QueryBlockType) => {
    onChange({
      ...blockTree,
      blocks: [...blockTree.blocks, createDefaultBlock(type)],
    });
  }, [blockTree, onChange]);
  
  const handleUpdateBlock = useCallback((index: number, updated: QueryBlock) => {
    const newBlocks = [...blockTree.blocks];
    newBlocks[index] = updated;
    onChange({ ...blockTree, blocks: newBlocks });
  }, [blockTree, onChange]);
  
  const handleDeleteBlock = useCallback((index: number) => {
    const newBlocks = blockTree.blocks.filter((_, i) => i !== index);
    onChange({ ...blockTree, blocks: newBlocks });
  }, [blockTree, onChange]);
  
  const handleClear = useCallback(() => {
    onChange(createEmptyBlockTree());
  }, [onChange]);
  
  return (
    <div className={`query-block-builder ${className}`}>
      {/* Header with logic toggle */}
      <div className="query-block-builder__header">
        <span className="query-block-builder__title">Filters</span>
        <div className="query-block-builder__spacer" />
        
        {!readOnly && blockTree.blocks.length > 0 && (
          <>
            <SelectionButton
              options={ROOT_LOGIC_OPTIONS}
              value={blockTree.type}
              onChange={handleRootTypeChange}
              size="sm"
            />
            <Button size="xs" variant="ghost" onClick={handleClear}>
              Clear
            </Button>
          </>
        )}
      </div>
      
      {/* Filter blocks */}
      <div className="query-block-builder__blocks">
        {blockTree.blocks.length === 0 ? (
          <div className="query-block-builder__empty">
            <p>No custom filters. Add filters to refine results.</p>
          </div>
        ) : (
          blockTree.blocks.map((block, index) => (
            <FilterBlock
              key={index}
              block={block}
              onUpdate={(updated) => handleUpdateBlock(index, updated)}
              onDelete={() => handleDeleteBlock(index)}
              readOnly={readOnly}
            />
          ))
        )}
      </div>
      
      {/* Add button */}
      {!readOnly && (
        <div className="query-block-builder__footer">
          <AddFilterButton onSelect={handleAddBlock} />
        </div>
      )}
    </div>
  );
}

export default QueryBlockBuilder;
