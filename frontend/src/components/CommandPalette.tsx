/**
 * CommandPalette - Floating search modal (Ctrl+K)
 * 
 * Features:
 * - Search all node names including parent hierarchy
 * - Pages section (with + Add page if no match)
 * - Blocks section  
 * - Auto-select first result for quick navigation
 * - Quick add section
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import './CommandPalette.css';
import { useSearch, useCreateNode, useTodayNote, usePages, usePageClass } from '@/hooks';
import { useNodesStore, useSettingsStore } from '@/stores';
import type { Node } from '@/types';
import { NodeIcon, BulletIcon, AddIcon } from './icons';
import { parseHierarchicalPath, resolveHierarchicalParent } from '@/utils/hierarchicalPath';

export interface CommandPaletteProps {
  /** Whether the palette is open */
  isOpen: boolean;
  /** Callback to close the palette */
  onClose: () => void;
  /** Callback when a node is selected */
  onSelect?: (node: Node) => void;
}

interface SearchResult {
  node: Node;
  type: 'page' | 'block';
  breadcrumb?: string;
}

/**
 * Build breadcrumb from node hierarchy
 */
function buildBreadcrumb(node: Node, allNodes: Node[]): string {
  const parts: string[] = [];
  let current: Node | undefined = node;
  
  // Walk up the parent chain
  while (current?.parent_id) {
    const parent = allNodes.find(n => n.id === current?.parent_id);
    if (parent) {
      parts.unshift(parent.name || 'Untitled');
      current = parent;
    } else {
      break;
    }
  }
  
  // If node has a page_id different from parent, add page name
  if (node.page_id && node.page_id !== node.parent_id) {
    const page = allNodes.find(n => n.id === node.page_id);
    if (page && !parts.includes(page.name || 'Untitled')) {
      parts.unshift(page.name || 'Untitled');
    }
  }
  
  return parts.join(' > ');
}

/**
 * Categorize search results into pages and blocks
 */
function categorizeResults(nodes: Node[]): { pages: SearchResult[]; blocks: SearchResult[] } {
  const pages: SearchResult[] = [];
  const blocks: SearchResult[] = [];
  
  for (const node of nodes) {
    const isPage = node.parent_id === null;
    const breadcrumb = isPage ? undefined : buildBreadcrumb(node, nodes);
    
    const result: SearchResult = { node, type: isPage ? 'page' : 'block', breadcrumb };
    
    if (isPage) {
      pages.push(result);
    } else {
      blocks.push(result);
    }
  }
  
  return { pages, blocks };
}

/**
 * Result item component
 */
function ResultItem({
  result,
  isSelected,
  onClick,
}: {
  result: SearchResult;
  isSelected: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  
  // Scroll into view when selected
  useEffect(() => {
    if (isSelected && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);
  
  return (
    <button
      ref={ref}
      className={`command-palette__result ${isSelected ? 'command-palette__result--selected' : ''}`}
      onClick={onClick}
    >
      <span className="command-palette__result-icon">
        {result.type === 'page' ? (
          <NodeIcon icon={result.node.icon} isPage={true} size="sm" />
        ) : (
          <BulletIcon size="xs" />
        )}
      </span>
      <span className="command-palette__result-content">
        <span className="command-palette__result-name">
          {result.node.name || 'Untitled'}
        </span>
        {result.breadcrumb && (
          <span className="command-palette__result-breadcrumb">
            {result.breadcrumb}
          </span>
        )}
      </span>
      <span className="command-palette__result-type">
        {result.type}
      </span>
    </button>
  );
}

/**
 * CommandPalette Component
 */
export function CommandPalette({
  isOpen,
  onClose,
  onSelect,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { openNode, addSidebarCard } = useNodesStore();
  const { quickAddDestination } = useSettingsStore();
  const { data: searchResults, isLoading } = useSearch(query);
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  
  // Get destination page for quick add
  const { data: todayNote } = useTodayNote();
  const { data: allPages } = usePages();
  const inboxPage = allPages?.find(p => p.name === 'Inbox');
  const destinationPage = quickAddDestination === 'today' ? todayNote : inboxPage;
  
  // Categorize results
  const { pages, blocks } = useMemo(() => {
    if (!searchResults) return { pages: [], blocks: [] };
    return categorizeResults(searchResults);
  }, [searchResults]);
  
  // All selectable items (pages, blocks, quick-add actions)
  const allItems = useMemo(() => {
    const items: Array<{ type: 'page' | 'block' | 'add-page' | 'quick-add'; result?: SearchResult; label?: string }> = [];
    
    // Pages section
    pages.forEach(result => items.push({ type: 'page', result }));
    
    // Add page option if query exists and no exact match
    if (query.trim() && !pages.some(p => p.node.name?.toLowerCase() === query.toLowerCase())) {
      items.push({ type: 'add-page', label: `Create page "${query}"` });
    }
    
    // Blocks section
    blocks.forEach(result => items.push({ type: 'block', result }));
    
    // Quick add option
    if (query.trim()) {
      items.push({ type: 'quick-add', label: `Quick add: "${query}"` });
    }
    
    return items;
  }, [pages, blocks, query]);
  
  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [allItems.length]);
  
  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);
  
  // Handle selection
  const handleSelect = useCallback(async (index: number) => {
    const item = allItems[index];
    if (!item) return;
    
    switch (item.type) {
      case 'page':
      case 'block':
        if (item.result) {
          if (onSelect) {
            onSelect(item.result.node);
          } else {
            openNode(item.result.node.id, item.type === 'page' ? 'page' : 'block');
          }
        }
        onClose();
        break;
        
      case 'add-page':
        // Create new page with hierarchical path support (e.g., "Pokemon/Charizard")
        console.log('[CommandPalette] Creating page with name:', query.trim());
        try {
          if (!pageClassId) {
            console.error('[CommandPalette] Page class not found');
            break;
          }
          
          const parsed = parseHierarchicalPath(query.trim());
          let parentId: number | null = null;
          
          // If hierarchical path, create parent pages as needed
          if (parsed.isHierarchical && allPages) {
            parentId = await resolveHierarchicalParent(
              parsed.parentSegments,
              allPages,
              async (name, parent) => {
                return await createNodeMutation.mutateAsync({
                  name,
                  parent_id: parent,
                  classes: [pageClassId],
                });
              }
            );
          }
          
          // Create the final page (leaf of the path)
          const newNode = await createNodeMutation.mutateAsync({
            name: parsed.leaf || query.trim(),
            parent_id: parentId,
            classes: [pageClassId],
          });
          console.log('[CommandPalette] Page created successfully:', newNode);
          onClose();
          openNode(newNode.id, 'page');
        } catch (error) {
          console.error('Failed to create page:', error);
        }
        break;
        
      case 'quick-add':
        // Quick add as block (to daily page or inbox)
        if (!destinationPage) {
          console.error('[CommandPalette] No destination page for quick add');
          break;
        }
        console.log('[CommandPalette] Quick adding block:', {
          name: query.trim(),
          parent_id: destinationPage.id,
          destination: quickAddDestination,
          destinationPage: { id: destinationPage.id, name: destinationPage.name },
        });
        try {
          const newNode = await createNodeMutation.mutateAsync({
            name: query.trim(),
            parent_id: destinationPage.id,
          });
          console.log('[CommandPalette] Quick add block created:', newNode);
        } catch (error) {
          console.error('Failed to quick add:', error);
        }
        onClose();
        break;
    }
  }, [allItems, query, onSelect, openNode, addSidebarCard, createNodeMutation, onClose]);
  
  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, allItems.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        handleSelect(selectedIndex);
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [allItems.length, selectedIndex, onClose, handleSelect]);
  
  // Close on backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);
  
  if (!isOpen) return null;
  
  // Group items for rendering
  const pageItems = allItems.filter(i => i.type === 'page' || i.type === 'add-page');
  const blockItems = allItems.filter(i => i.type === 'block');
  const quickAddItems = allItems.filter(i => i.type === 'quick-add');
  
  return (
    <div className="command-palette__backdrop" onClick={handleBackdropClick}>
      <div ref={containerRef} className="command-palette">
        <div className="command-palette__input-container">
          <input
            ref={inputRef}
            type="text"
            className="command-palette__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages and blocks..."
          />
          <kbd className="command-palette__shortcut">Esc</kbd>
        </div>
        
        <div className="command-palette__results">
          {isLoading && (
            <div className="command-palette__loading">Searching...</div>
          )}
          
          {!isLoading && query && allItems.length === 0 && (
            <div className="command-palette__empty">No results found</div>
          )}
          
          {!isLoading && !query && (
            <div className="command-palette__hint">
              Start typing to search pages and blocks
            </div>
          )}
          
          {/* Pages section */}
          {pageItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Pages</div>
              {pageItems.map((item) => {
                const globalIndex = allItems.indexOf(item);
                if (item.type === 'add-page') {
                  return (
                    <button
                      key="add-page"
                      className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <span className="command-palette__result-icon">
                        <AddIcon size="sm" />
                      </span>
                      <span className="command-palette__result-content">
                        <span className="command-palette__result-name">{item.label}</span>
                      </span>
                    </button>
                  );
                }
                return (
                  <ResultItem
                    key={item.result?.node.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                  />
                );
              })}
            </div>
          )}
          
          {/* Blocks section */}
          {blockItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Blocks</div>
              {blockItems.map((item) => {
                const globalIndex = allItems.indexOf(item);
                return (
                  <ResultItem
                    key={item.result?.node.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                  />
                );
              })}
            </div>
          )}
          
          {/* Quick Add section */}
          {quickAddItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Quick Add</div>
              {quickAddItems.map((item) => {
                const globalIndex = allItems.indexOf(item);
                return (
                  <button
                    key="quick-add"
                    className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                    onClick={() => handleSelect(globalIndex)}
                  >
                    <span className="command-palette__result-icon">
                      <AddIcon size="sm" />
                    </span>
                    <span className="command-palette__result-content">
                      <span className="command-palette__result-name">{item.label}</span>
                    </span>
                    <kbd className="command-palette__item-shortcut">⌘↵</kbd>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        
        <div className="command-palette__footer">
          <span className="command-palette__footer-hint">
            <kbd>↑</kbd><kbd>↓</kbd> to navigate
          </span>
          <span className="command-palette__footer-hint">
            <kbd>↵</kbd> to select
          </span>
          <span className="command-palette__footer-hint">
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
