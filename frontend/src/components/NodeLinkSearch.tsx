/**
 * NodeLinkSearch Modal
 * 
 * A modal for searching and selecting nodes (pages or blocks) to create links.
 * Features:
 * - Search box for filtering by page name or block content
 * - Insert and Cancel buttons
 * - Keyboard navigation support
 */
import { useState, useCallback, useEffect, useMemo } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { useSearch, usePages, useNodes, useCreatePage } from '@/hooks';
import type { Node } from '@/types';
import { AddIcon, NodeIcon, BulletIcon } from './icons';
import './NodeLinkSearch.css';

export type LinkSearchType = 'page-link' | 'block-link';

export interface NodeLinkSearchProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** The type of link to create */
  linkType: LinkSearchType;
  /** Callback when a node is selected */
  onSelect: (node: Node) => void;
  /** Callback to close the modal */
  onClose: () => void;
  /** Optional: Pre-fill search query */
  initialQuery?: string;
}

export function NodeLinkSearch({
  isOpen,
  linkType,
  onSelect,
  onClose,
  initialQuery = '',
}: NodeLinkSearchProps) {
  const [query, setQuery] = useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = useState(0);
  
  // Fetch pages for page-link search
  const { data: allPages = [] } = usePages();
  
  // Fetch all nodes for block-link search
  const { data: allNodes = [] } = useNodes(null);
  
  // Use search API when query is provided
  const { data: searchResults = [] } = useSearch(query);
  
  // Create page mutation
  const createPageMutation = useCreatePage();
  
  // Separate pages and blocks from results
  const { pageResults, blockResults } = useMemo(() => {
    const lowercaseQuery = query.toLowerCase();
    
    // Combine and deduplicate results
    const pagesMap = new Map<number, Node>();
    const blocksMap = new Map<number, Node>();
    
    // Add search API results first (they're more relevant)
    if (searchResults) {
      searchResults.forEach(node => {
        if (node.is_page) {
          pagesMap.set(node.id, node);
        } else {
          blocksMap.set(node.id, node);
        }
      });
    }
    
    // For page-link, also include pages list
    if (linkType === 'page-link' && query.length < 2) {
      allPages.forEach(node => {
        if (!pagesMap.has(node.id)) {
          const name = (node.name || '').toLowerCase();
          const displayName = (node.display_name || '').toLowerCase();
          
          if (!query || name.includes(lowercaseQuery) || displayName.includes(lowercaseQuery)) {
            pagesMap.set(node.id, node);
          }
        }
      });
    }
    
    // For block-link, also include blocks list
    if (linkType === 'block-link' && query.length < 2) {
      allNodes.filter(n => !n.is_page).forEach(node => {
        if (!blocksMap.has(node.id)) {
          const name = (node.name || '').toLowerCase();
          const displayName = (node.display_name || '').toLowerCase();
          
          if (!query || name.includes(lowercaseQuery) || displayName.includes(lowercaseQuery)) {
            blocksMap.set(node.id, node);
          }
        }
      });
    }
    
    return {
      pageResults: Array.from(pagesMap.values()).slice(0, 10),
      blockResults: Array.from(blocksMap.values()).slice(0, 10)
    };
  }, [allPages, allNodes, searchResults, query, linkType]);
  
  // Check if we should show "Create page" option
  const showCreatePage = useMemo(() => {
    if (linkType !== 'page-link' || !query.trim()) return false;
    // Show if no exact match exists
    return !pageResults.some(p => p.name?.toLowerCase() === query.toLowerCase());
  }, [linkType, query, pageResults]);
  
  // Build all selectable items (pages, optional create, blocks)
  const allItems = useMemo(() => {
    const items: Array<{ type: 'page' | 'create-page' | 'block'; node?: Node; label?: string }> = [];
    
    // Pages first
    pageResults.forEach(node => items.push({ type: 'page', node }));
    
    // Create page option (after pages, before blocks)
    if (showCreatePage) {
      items.push({ type: 'create-page', label: `Create page "${query}"` });
    }
    
    // Blocks last
    blockResults.forEach(node => items.push({ type: 'block', node }));
    
    return items;
  }, [pageResults, blockResults, showCreatePage, query]);
  
  // Create a map of page IDs to names for quick lookup
  const pageNamesMap = useMemo(() => {
    const map = new Map<number, string>();
    allPages.forEach(page => {
      map.set(page.id, page.name || page.display_name || 'Untitled');
    });
    return map;
  }, [allPages]);
  
  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [allItems.length]);
  
  // Reset query when modal opens
  useEffect(() => {
    if (isOpen) {
      setQuery(initialQuery);
      setSelectedIndex(0);
    }
  }, [isOpen, initialQuery]);
  
  // Handle selection
  const handleSelect = useCallback(async (index: number) => {
    const item = allItems[index];
    if (!item) return;
    
    if (item.type === 'create-page') {
      try {
        const newPage = await createPageMutation.mutateAsync({ name: query.trim() });
        onSelect(newPage);
      } catch (error) {
        console.error('Failed to create page:', error);
      }
    } else if (item.node) {
      onSelect(item.node);
    }
  }, [allItems, query, createPageMutation, onSelect]);
  
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
  }, [allItems.length, selectedIndex, handleSelect, onClose]);
  
  // Handle insert button
  const handleInsert = useCallback(() => {
    handleSelect(selectedIndex);
  }, [selectedIndex, handleSelect]);
  
  const title = linkType === 'page-link' ? 'Link to Page' : 'Link to Block';
  const placeholder = linkType === 'page-link' 
    ? 'Search for a page...' 
    : 'Search for a block...';
  
  // Group items for rendering with section headers
  const pageItems = allItems.filter(i => i.type === 'page' || i.type === 'create-page');
  const blockItems = allItems.filter(i => i.type === 'block');
  
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <div className="node-link-search__footer">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button 
            variant="primary" 
            onClick={handleInsert}
            disabled={allItems.length === 0}
          >
            Insert
          </Button>
        </div>
      }
    >
      <div className="node-link-search" onKeyDown={handleKeyDown}>
        <input
          type="text"
          className="node-link-search__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          autoFocus
        />
        
        <div className="node-link-search__results">
          {allItems.length === 0 ? (
            <div className="node-link-search__empty">
              {query ? 'No matching results' : 'Type to search...'}
            </div>
          ) : (
            <>
              {/* Pages section */}
              {pageItems.length > 0 && (
                <div className="node-link-search__section">
                  <div className="node-link-search__section-header">Pages</div>
                  {pageItems.map((item) => {
                    const globalIndex = allItems.indexOf(item);
                    if (item.type === 'create-page') {
                      return (
                        <button
                          key="create-page"
                          className={`node-link-search__item node-link-search__item--action ${globalIndex === selectedIndex ? 'node-link-search__item--selected' : ''}`}
                          onClick={() => handleSelect(globalIndex)}
                          onMouseEnter={() => setSelectedIndex(globalIndex)}
                        >
                          <span className="node-link-search__item-icon">
                            <AddIcon size="sm" />
                          </span>
                          <div className="node-link-search__item-content">
                            <span className="node-link-search__item-name">{item.label}</span>
                          </div>
                        </button>
                      );
                    }
                    return (
                      <button
                        key={item.node!.id}
                        className={`node-link-search__item ${globalIndex === selectedIndex ? 'node-link-search__item--selected' : ''}`}
                        onClick={() => handleSelect(globalIndex)}
                        onMouseEnter={() => setSelectedIndex(globalIndex)}
                      >
                        <span className="node-link-search__item-icon">
                          <NodeIcon icon={item.node!.icon} isPage={true} size="sm" />
                        </span>
                        <div className="node-link-search__item-content">
                          <span className="node-link-search__item-name">
                            {item.node!.name || item.node!.display_name || 'Untitled'}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              
              {/* Blocks section */}
              {blockItems.length > 0 && (
                <div className="node-link-search__section">
                  <div className="node-link-search__section-header">Blocks</div>
                  {blockItems.map((item) => {
                    const globalIndex = allItems.indexOf(item);
                    return (
                      <button
                        key={item.node!.id}
                        className={`node-link-search__item ${globalIndex === selectedIndex ? 'node-link-search__item--selected' : ''}`}
                        onClick={() => handleSelect(globalIndex)}
                        onMouseEnter={() => setSelectedIndex(globalIndex)}
                      >
                        <span className="node-link-search__item-icon">
                          <BulletIcon size="xs" />
                        </span>
                        <div className="node-link-search__item-content">
                          <span className="node-link-search__item-name">
                            {item.node!.name || item.node!.display_name || 'Untitled'}
                          </span>
                          {item.node!.page_id && (
                            <span className="node-link-search__item-path">
                              in {pageNamesMap.get(item.node!.page_id) || 'Unknown'}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
        
        <div className="node-link-search__hint">
          <span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span>
          <span><kbd>Enter</kbd> to select</span>
          <span><kbd>Esc</kbd> to cancel</span>
        </div>
      </div>
    </Modal>
  );
}

export default NodeLinkSearch;
