/**
 * QuickPageFilter Component
 * 
 * A funnel-variant button that opens a dropdown for quick page filtering.
 * - Click on a page adds a PARENT_PATH filter (nodes inside that page)
 * - Shift+click adds a negated filter (nodes NOT inside that page)
 * - Shows currently selected pages with checkboxes (dot for negated)
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useNodeSearch, usePages } from '@/hooks';
import type { Node } from '@/types/api';
import type { QueryBlock, QueryBlockTree } from '@/types/query';
import { Button } from '../core/Button';
import { Badge } from '../core/Badge';
import { Checkbox } from '../core/Checkbox';
import { NodeIcon } from '../icons';
import { mdiFilterPlusOutline } from '@mdi/js';
import './QuickPageFilter.css';

interface PageFilterState {
  uuid: string;
  name: string;
  icon: string | null;
  negated: boolean;
}

interface QuickPageFilterProps {
  /** Current block tree to analyze and modify */
  blockTree: QueryBlockTree;
  /** Callback when block tree changes */
  onChange: (blockTree: QueryBlockTree) => void;
  /** Size variant */
  size?: 'xs' | 'sm' | 'md';
  /** Additional CSS class */
  className?: string;
}

/**
 * Extract page filter states from a block tree
 */
function extractPageFilters(tree: QueryBlockTree): PageFilterState[] {
  const filters: PageFilterState[] = [];
  
  for (const block of tree.blocks) {
    // Direct PARENT_PATH block
    if (block.type === 'PARENT_PATH') {
      const parentPathBlock = block as { blocks?: QueryBlock[] };
      const uuidBlock = parentPathBlock.blocks?.find(b => b.type === 'UUID') as { value?: string } | undefined;
      if (uuidBlock?.value && !uuidBlock.value.startsWith('{')) {
        filters.push({
          uuid: uuidBlock.value,
          name: '', // Will be populated later
          icon: null,
          negated: false,
        });
      }
    }
    // NOT_CONTAINER wrapping PARENT_PATH (negated)
    else if (block.type === 'NOT_CONTAINER') {
      const notBlock = block as { block?: QueryBlock };
      if (notBlock.block?.type === 'PARENT_PATH') {
        const parentPathBlock = notBlock.block as { blocks?: QueryBlock[] };
        const uuidBlock = parentPathBlock.blocks?.find(b => b.type === 'UUID') as { value?: string } | undefined;
        if (uuidBlock?.value && !uuidBlock.value.startsWith('{')) {
          filters.push({
            uuid: uuidBlock.value,
            name: '',
            icon: null,
            negated: true,
          });
        }
      }
    }
  }
  
  return filters;
}

/**
 * Create a PARENT_PATH block for a page
 */
function createParentPathBlock(uuid: string): QueryBlock {
  return {
    type: 'PARENT_PATH',
    blocks: [{ type: 'UUID', value: uuid }],
  };
}

/**
 * QuickPageFilter Component
 */
export function QuickPageFilter({
  blockTree,
  onChange,
  size = 'xs',
  className = '',
}: QuickPageFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Fetch all pages for name lookup
  const { data: allPages = [] } = usePages();
  
  // Search for pages
  const { allResults, isLoading } = useNodeSearch(query, {
    mode: 'pages',
    maxResults: 10,
  });
  
  // Filter to only pages
  const searchResults = useMemo(() => 
    allResults.map(r => r.node).filter(n => n.is_page),
    [allResults]
  );
  
  // Get current page filters with names
  const currentFilters = useMemo(() => {
    const filters = extractPageFilters(blockTree);
    // Populate names from allPages
    return filters.map(f => {
      const page = allPages.find(p => p.uuid === f.uuid);
      return {
        ...f,
        name: page?.name ?? 'Unknown page',
        icon: page?.icon ?? null,
      };
    });
  }, [blockTree, allPages]);
  
  // Count of active page filters
  const filterCount = currentFilters.length;
  
  // Add a page filter
  const handleAddPageFilter = useCallback((page: Node, negated: boolean) => {
    // Check if already exists
    const existingIndex = currentFilters.findIndex(f => f.uuid === page.uuid);
    if (existingIndex >= 0) {
      // Already exists - toggle or update
      handleRemovePageFilter(page.uuid);
      if (currentFilters[existingIndex].negated !== negated) {
        // Re-add with opposite negation
        const newBlock = negated
          ? { type: 'NOT_CONTAINER' as const, block: createParentPathBlock(page.uuid) }
          : createParentPathBlock(page.uuid);
        onChange({
          ...blockTree,
          blocks: [...blockTree.blocks, newBlock],
        });
      }
      return;
    }
    
    // Add new filter
    const newBlock = negated
      ? { type: 'NOT_CONTAINER' as const, block: createParentPathBlock(page.uuid) }
      : createParentPathBlock(page.uuid);
    
    onChange({
      ...blockTree,
      blocks: [...blockTree.blocks, newBlock],
    });
    
    setQuery('');
  }, [blockTree, currentFilters, onChange]);
  
  // Remove a page filter by UUID
  const handleRemovePageFilter = useCallback((uuid: string) => {
    const newBlocks = blockTree.blocks.filter(block => {
      // Check direct PARENT_PATH
      if (block.type === 'PARENT_PATH') {
        const parentPathBlock = block as { blocks?: QueryBlock[] };
        const uuidBlock = parentPathBlock.blocks?.find(b => b.type === 'UUID') as { value?: string } | undefined;
        return uuidBlock?.value !== uuid;
      }
      // Check NOT_CONTAINER wrapping PARENT_PATH
      if (block.type === 'NOT_CONTAINER') {
        const notBlock = block as { block?: QueryBlock };
        if (notBlock.block?.type === 'PARENT_PATH') {
          const parentPathBlock = notBlock.block as { blocks?: QueryBlock[] };
          const uuidBlock = parentPathBlock.blocks?.find(b => b.type === 'UUID') as { value?: string } | undefined;
          return uuidBlock?.value !== uuid;
        }
      }
      return true;
    });
    
    onChange({
      ...blockTree,
      blocks: newBlocks,
    });
  }, [blockTree, onChange]);
  
  // Handle click on search result
  const handleResultClick = useCallback((page: Node, e: React.MouseEvent) => {
    const negated = e.shiftKey;
    handleAddPageFilter(page, negated);
  }, [handleAddPageFilter]);
  
  // Toggle filter negation state
  const handleToggleNegated = useCallback((uuid: string, currentlyNegated: boolean) => {
    const page = allPages.find(p => p.uuid === uuid);
    if (!page) return;
    
    // Remove existing and re-add with opposite negation
    handleRemovePageFilter(uuid);
    const newBlock = currentlyNegated
      ? createParentPathBlock(uuid)
      : { type: 'NOT_CONTAINER' as const, block: createParentPathBlock(uuid) };
    
    onChange({
      ...blockTree,
      blocks: [...blockTree.blocks.filter(b => {
        // Re-filter since handleRemovePageFilter is async-ish
        if (b.type === 'PARENT_PATH') {
          const ab = b as { blocks?: QueryBlock[] };
          const ub = ab.blocks?.find(x => x.type === 'UUID') as { value?: string } | undefined;
          return ub?.value !== uuid;
        }
        if (b.type === 'NOT_CONTAINER') {
          const nb = b as { block?: QueryBlock };
          if (nb.block?.type === 'PARENT_PATH') {
            const ab = nb.block as { blocks?: QueryBlock[] };
            const ub = ab.blocks?.find(x => x.type === 'UUID') as { value?: string } | undefined;
            return ub?.value !== uuid;
          }
        }
        return true;
      }), newBlock],
    });
  }, [blockTree, allPages, onChange]);
  
  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        setIsOpen(false);
        setQuery('');
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  
  // Focus input when opening
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);
  
  return (
    <div className={`quick-page-filter ${className}`} ref={containerRef}>
      {/* Trigger button with badge */}
      <div className="quick-page-filter__trigger-wrapper">
        <Button
          icon={mdiFilterPlusOutline}
          iconOnly
          variant="ghost"
          size={size}
          onClick={() => setIsOpen(!isOpen)}
          title="Quick page filter (Shift+click for exclude)"
        />
        {filterCount > 0 && (
          <Badge variant="primary" size="xs" className="quick-page-filter__badge">
            {filterCount}
          </Badge>
        )}
      </div>
      
      {/* Dropdown */}
      {isOpen && (
        <div className="quick-page-filter__dropdown">
          {/* Search input */}
          <div className="quick-page-filter__search">
            <input
              ref={inputRef}
              type="text"
              className="quick-page-filter__input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pages..."
            />
          </div>
          
          {/* Current filters */}
          {currentFilters.length > 0 && (
            <div className="quick-page-filter__section">
              <div className="quick-page-filter__section-header">Active filters</div>
              <div className="quick-page-filter__list">
                {currentFilters.map(filter => (
                  <div key={filter.uuid} className="quick-page-filter__item quick-page-filter__item--active">
                    <Checkbox
                      checked={true}
                      variant={filter.negated ? 'dot' : 'check'}
                      size="sm"
                      onChange={() => handleRemovePageFilter(filter.uuid)}
                      title={filter.negated ? 'Excluding nodes inside this page' : 'Including nodes inside this page'}
                    />
                    <NodeIcon icon={filter.icon} isPage={true} size="xs" />
                    <span className="quick-page-filter__item-name">{filter.name}</span>
                    <button
                      className="quick-page-filter__item-toggle"
                      onClick={() => handleToggleNegated(filter.uuid, filter.negated)}
                      title={filter.negated ? 'Switch to include' : 'Switch to exclude'}
                    >
                      {filter.negated ? 'excl' : 'incl'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* Search results */}
          {query && (
            <div className="quick-page-filter__section">
              <div className="quick-page-filter__section-header">
                Search results
                <span className="quick-page-filter__hint">(Shift+click to exclude)</span>
              </div>
              {isLoading ? (
                <div className="quick-page-filter__loading">Searching...</div>
              ) : searchResults.length > 0 ? (
                <div className="quick-page-filter__list">
                  {searchResults.map(page => {
                    const existingFilter = currentFilters.find(f => f.uuid === page.uuid);
                    return (
                      <div
                        key={page.id}
                        className={`quick-page-filter__item ${existingFilter ? 'quick-page-filter__item--selected' : ''}`}
                        onClick={(e) => handleResultClick(page, e)}
                      >
                        <Checkbox
                          checked={!!existingFilter}
                          variant={existingFilter?.negated ? 'dot' : 'check'}
                          size="sm"
                          readOnly
                        />
                        <NodeIcon icon={page.icon} isPage={true} size="xs" />
                        <span className="quick-page-filter__item-name">{page.name || 'Untitled'}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="quick-page-filter__empty">No pages found</div>
              )}
            </div>
          )}
          
          {/* Hint when empty */}
          {!query && currentFilters.length === 0 && (
            <div className="quick-page-filter__hint-box">
              <p>Type to search for pages</p>
              <p className="quick-page-filter__hint">
                <strong>Click</strong> to include nodes inside a page
              </p>
              <p className="quick-page-filter__hint">
                <strong>Shift+Click</strong> to exclude nodes
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default QuickPageFilter;
