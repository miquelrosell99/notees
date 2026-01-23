/**
 * QueryBlockBuilder Component
 * 
 * Query builder UI with:
 * - Top-level AND/OR toggle using SelectionButton
 * - Filter rows with field → operator → value layout
 * - NodePicker for relational fields (types, references, pages)
 * - NodeTypePill for multi-value selections
 * - Card component for each query block
 * - X button to delete blocks
 * - Dynamic query mode for node-type filters
 */
import { useCallback } from 'react';
import { Button } from '../core/Button';
import { SelectionButton } from '../core/SelectionButton';
import { FilterBlock } from './FilterBlocks';
import { AddFilterButton } from './AddFilterButton';
import { ROOT_LOGIC_OPTIONS, createDefaultBlock } from './constants';
import type {
  QueryBlock,
  QueryBlockTree,
  QueryBlockType,
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

// Re-export for convenience
export { createDefaultBlock } from './constants';
export { FilterBlock } from './FilterBlocks';
export { AddFilterButton } from './AddFilterButton';
export { NodeSelector, SingleNodeSelector } from './NodeSelectors';

export default QueryBlockBuilder;
