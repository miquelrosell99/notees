/**
 * QueryBlockBuilder Component
 * 
 * Query builder UI with:
 * - Top-level AND/OR toggle using SelectionButton
 * - Filter rows with field → operator → value layout
 * - NodePicker for relational fields (classes, references, pages)
 * - NodeClassPill for multi-value selections
 * - Card component for each query block
 * - X button to delete blocks
 * - Dynamic query mode for node-class filters
 * - System blocks (with placeholders) are hidden from users
 */
import { useCallback, useMemo } from 'react';
import { Button } from '../core/Button';
import { SelectionButton } from '../core/SelectionButton';
import { FilterBlock } from './FilterBlocks';
import { AddFilterButton } from './AddFilterButton';
import { ROOT_LOGIC_OPTIONS, createDefaultBlock, isSystemBlock } from './constants';
import type {
  QueryBlock,
  QueryBlockTree,
  QueryBlockType,
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
  
  // Filter out system blocks (those with placeholder values like {current_node_uuid})
  // These are default query blocks that users shouldn't see or edit
  const { visibleBlocks, hiddenIndices } = useMemo(() => {
    const hidden: number[] = [];
    const visible: { block: QueryBlock; originalIndex: number }[] = [];
    
    blockTree.blocks.forEach((block, index) => {
      if (isSystemBlock(block)) {
        hidden.push(index);
      } else {
        visible.push({ block, originalIndex: index });
      }
    });
    
    return { visibleBlocks: visible, hiddenIndices: hidden };
  }, [blockTree.blocks]);
  
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
  
  const handleUpdateBlock = useCallback((originalIndex: number, updated: QueryBlock) => {
    const newBlocks = [...blockTree.blocks];
    newBlocks[originalIndex] = updated;
    onChange({ ...blockTree, blocks: newBlocks });
  }, [blockTree, onChange]);
  
  const handleDeleteBlock = useCallback((originalIndex: number) => {
    const newBlocks = blockTree.blocks.filter((_, i) => i !== originalIndex);
    onChange({ ...blockTree, blocks: newBlocks });
  }, [blockTree, onChange]);
  
  const handleMoveBlock = useCallback((originalIndex: number, direction: 'up' | 'down') => {
    const newBlocks = [...blockTree.blocks];
    const targetIndex = direction === 'up' ? originalIndex - 1 : originalIndex + 1;
    
    // Don't move past array bounds
    if (targetIndex < 0 || targetIndex >= newBlocks.length) return;
    
    // Skip over system blocks when moving
    let finalTarget = targetIndex;
    while (hiddenIndices.includes(finalTarget) && finalTarget >= 0 && finalTarget < newBlocks.length) {
      finalTarget = direction === 'up' ? finalTarget - 1 : finalTarget + 1;
    }
    
    if (finalTarget < 0 || finalTarget >= newBlocks.length) return;
    
    // Swap
    [newBlocks[originalIndex], newBlocks[finalTarget]] = [newBlocks[finalTarget], newBlocks[originalIndex]];
    onChange({ ...blockTree, blocks: newBlocks });
  }, [blockTree, onChange, hiddenIndices]);
  
  const handleClear = useCallback(() => {
    // Keep system blocks, only clear user-added blocks
    const systemBlocks = blockTree.blocks.filter((block) => isSystemBlock(block));
    onChange({ ...blockTree, blocks: systemBlocks });
  }, [blockTree, onChange]);
  
  return (
    <div className={`query-block-builder ${className}`}>
      {/* Header with logic toggle */}
      <div className="query-block-builder__header">
        <span className="query-block-builder__title">Filters</span>
        <div className="query-block-builder__spacer" />
        
        {!readOnly && visibleBlocks.length > 0 && (
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
        {visibleBlocks.length === 0 ? (
          <div className="query-block-builder__empty">
            <p>No custom filters. Add filters to refine results.</p>
          </div>
        ) : (
          visibleBlocks.map(({ block, originalIndex }, visibleIndex) => (
            <FilterBlock
              key={originalIndex}
              block={block}
              onUpdate={(updated) => handleUpdateBlock(originalIndex, updated)}
              onDelete={() => handleDeleteBlock(originalIndex)}
              readOnly={readOnly}
              index={visibleIndex}
              totalSiblings={visibleBlocks.length}
              onMoveUp={() => handleMoveBlock(originalIndex, 'up')}
              onMoveDown={() => handleMoveBlock(originalIndex, 'down')}
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
