/**
 * SuggestionPopup - Floating popup for various triggers
 * 
 * Shows matching nodes when user types trigger characters in the editor.
 * - @ triggers type selection (nodes with "type" tag)
 * - # triggers tag selection (any page)
 * - [[ triggers link selection (pages first, then blocks)
 * 
 * Enter: Add to property only (for @ and #) or insert link (for [[)
 * Ctrl+Enter: Add to property AND keep inline
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import './SuggestionPopup.css';
import { useSearch, usePages, useNodes, useTypes, useSearchTypes } from '@/hooks';
import type { Node } from '@/types';
import { NodeIcon, TagIcon, AddIcon, BulletIcon } from '../icons';

export type SuggestionType = 'type' | 'tag' | 'link';

export interface SuggestionPopupProps {
  /** Whether the popup is visible */
  isOpen: boolean;
  /** The search query (text after @ or #) */
  query: string;
  /** Type of suggestion (type, tag, or link) */
  type: SuggestionType;
  /** Position to render the popup */
  position: { top: number; left: number };
  /** Callback when an item is selected */
  onSelect: (node: Node, keepInline: boolean) => void;
  /** Callback to close the popup */
  onClose: () => void;
  /** Callback to create a new item if none exist */
  onCreate?: (name: string, keepInline: boolean) => void;
  /** Node ID to exclude from link results (used for non-page blocks) */
  excludeNodeId?: number;
}

interface SuggestionItem {
  node: Node;
  displayName: string;
  section: 'page' | 'block';
}

/**
 * SuggestionPopup Component
 */
export function SuggestionPopup({
  isOpen,
  query,
  type,
  position,
  onSelect,
  onClose,
  onCreate,
  excludeNodeId,
}: SuggestionPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Search for matching nodes (general search for links and tags)
  const { data: searchResults, isLoading } = useSearch(query);
  const { data: allPages } = usePages();
  // Fetch all nodes when we need blocks (for link type with empty query)
  const { data: allNodes } = useNodes(type === 'link' && query.length === 0 ? {} : null);
  
  // Fetch types specifically when type === 'type'
  const { data: allTypeNodes } = useTypes();
  const { data: typeSearchResults } = useSearchTypes(type === 'type' ? query : '');
  
  // Filter and organize results based on type
  const { pageResults, blockResults } = useMemo(() => {
    if (type === 'link') {
      // For links [[]], show pages first, then blocks
      let baseResults = query.length > 0 ? (searchResults ?? []) : [...(allPages ?? []).slice(0, 5), ...(allNodes ?? []).filter(n => n.parent_id !== null).slice(0, 5)];
      
      // Filter out excluded node (e.g., self-reference for non-page blocks)
      if (excludeNodeId !== undefined) {
        baseResults = baseResults.filter(n => n.id !== excludeNodeId);
      }
      
      const pages: SuggestionItem[] = [];
      const blocks: SuggestionItem[] = [];
      
      for (const node of baseResults) {
        if (node.is_page || node.parent_id === null) {
          pages.push({
            node,
            displayName: node.name || 'Untitled',
            section: 'page',
          });
        } else {
          blocks.push({
            node,
            displayName: node.name || node.display_name || 'Untitled block',
            section: 'block',
          });
        }
      }
      
      return { 
        pageResults: pages.slice(0, 10), 
        blockResults: blocks.slice(0, 10) 
      };
    }
    
    // For types (@): show only actual type nodes
    if (type === 'type') {
      const results = query.length > 0 
        ? (typeSearchResults ?? []) 
        : (allTypeNodes ?? []).slice(0, 10);
      
      return {
        pageResults: results.map(node => ({
          node,
          displayName: node.name || 'Untitled',
          section: 'page' as const,
        })),
        blockResults: [],
      };
    }
    
    // For tags (#): show all pages
    if (!searchResults && !allPages) return { pageResults: [], blockResults: [] };
    
    const results = query.length > 0 ? (searchResults ?? []) : (allPages ?? []).slice(0, 10);
    
    return {
      pageResults: results.map(node => ({
        node,
        displayName: node.name || 'Untitled',
        section: 'page' as const,
      })),
      blockResults: [],
    };
  }, [searchResults, allPages, allNodes, allTypeNodes, typeSearchResults, query, type, excludeNodeId]);
  
  // Combined list for navigation
  const allItems = useMemo(() => {
    return [...pageResults, ...blockResults];
  }, [pageResults, blockResults]);
  
  // Check if we need to show "Create new" option
  const showCreateOption = useMemo(() => {
    if (!query.trim()) return false;
    const exactMatch = pageResults.some(
      r => r.displayName.toLowerCase() === query.toLowerCase()
    );
    return !exactMatch;
  }, [pageResults, query]);
  
  // Total selectable items (results + possibly create option)
  const totalItems = allItems.length + (showCreateOption ? 1 : 0);
  
  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [allItems.length, query]);
  
  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isOpen) return;
    
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(i => Math.min(i + 1, totalItems - 1));
        break;
        
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
        
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        const keepInline = e.ctrlKey;
        
        if (selectedIndex < allItems.length) {
          // Select existing item
          onSelect(allItems[selectedIndex].node, keepInline);
        } else if (showCreateOption && onCreate) {
          // Create new item
          onCreate(query.trim(), keepInline);
        }
        break;
        
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
        
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
    }
  }, [isOpen, selectedIndex, totalItems, allItems, showCreateOption, query, onSelect, onCreate, onClose]);
  
  // Attach keyboard listener
  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown, true);
      return () => document.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [isOpen, handleKeyDown]);
  
  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);
  
  // Adjust position to stay within viewport
  const adjustedPosition = useMemo(() => {
    if (!isOpen) return position;
    
    const popupWidth = 280;
    const popupHeight = 320;
    const padding = 8;
    
    let { top, left } = position;
    
    // Adjust horizontal position
    if (left + popupWidth > window.innerWidth - padding) {
      left = window.innerWidth - popupWidth - padding;
    }
    if (left < padding) {
      left = padding;
    }
    
    // Adjust vertical position - flip above if not enough space below
    if (top + popupHeight > window.innerHeight - padding) {
      top = position.top - popupHeight - 24; // Flip above cursor
    }
    
    return { top, left };
  }, [isOpen, position]);
  
  if (!isOpen) return null;
  
  // Calculate indices for each section
  const pageStartIndex = 0;
  const blockStartIndex = pageResults.length;
  const createIndex = allItems.length;
  
  return (
    <div
      ref={containerRef}
      className="suggestion-popup"
      style={{
        position: 'fixed',
        top: adjustedPosition.top,
        left: adjustedPosition.left,
        zIndex: 1000,
      }}
    >
      <div className="suggestion-popup__header">
        {type === 'type' ? (
          <>
            <span className="suggestion-popup__icon">@</span>
            <span>Set type</span>
          </>
        ) : type === 'tag' ? (
          <>
            <span className="suggestion-popup__icon">#</span>
            <span>Add tag</span>
          </>
        ) : (
          <>
            <span className="suggestion-popup__icon">[[</span>
            <span>Insert link</span>
          </>
        )}
      </div>
      
      <div className="suggestion-popup__list">
        {isLoading && query.length > 0 ? (
          <div className="suggestion-popup__loading">Searching...</div>
        ) : allItems.length === 0 && !showCreateOption ? (
          <div className="suggestion-popup__empty">
            {query ? 'No matches found' : 'Start typing to search'}
          </div>
        ) : (
          <>
            {/* Pages Section */}
            {type === 'link' && pageResults.length > 0 && (
              <div className="suggestion-popup__section">
                <div className="suggestion-popup__section-header">Pages</div>
                {pageResults.map((item, index) => {
                  const globalIndex = pageStartIndex + index;
                  return (
                    <button
                      key={item.node.id}
                      className={`suggestion-popup__item ${globalIndex === selectedIndex ? 'suggestion-popup__item--selected' : ''}`}
                      onClick={() => onSelect(item.node, false)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                    >
                      <span className="suggestion-popup__item-icon">
                        <NodeIcon icon={item.node.icon} isPage={true} size="sm" />
                      </span>
                      <span className="suggestion-popup__item-name">
                        {item.displayName}
                      </span>
                    </button>
                  );
                })}
                
                {/* Create page button at bottom of pages section */}
                {showCreateOption && onCreate && (
                  <button
                    className={`suggestion-popup__item suggestion-popup__item--create ${
                      selectedIndex === createIndex ? 'suggestion-popup__item--selected' : ''
                    }`}
                    onClick={() => onCreate(query.trim(), false)}
                    onMouseEnter={() => setSelectedIndex(createIndex)}
                  >
                    <span className="suggestion-popup__item-icon">
                      <AddIcon size="sm" />
                    </span>
                    <span className="suggestion-popup__item-name">
                      Create page "{query.trim()}"
                    </span>
                  </button>
                )}
              </div>
            )}
            
            {/* Blocks Section - only show if there are results */}
            {type === 'link' && blockResults.length > 0 && (
              <div className="suggestion-popup__section">
                <div className="suggestion-popup__section-header">Blocks</div>
                {blockResults.map((item, index) => {
                  const globalIndex = blockStartIndex + index;
                  return (
                    <button
                      key={item.node.id}
                      className={`suggestion-popup__item ${globalIndex === selectedIndex ? 'suggestion-popup__item--selected' : ''}`}
                      onClick={() => onSelect(item.node, false)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                    >
                      <span className="suggestion-popup__item-icon">
                        <BulletIcon size="sm" />
                      </span>
                      <span className="suggestion-popup__item-name">
                        {item.displayName}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            
            {/* For type/tag mode - show flat list */}
            {type !== 'link' && pageResults.map((item, index) => (
              <button
                key={item.node.id}
                className={`suggestion-popup__item ${index === selectedIndex ? 'suggestion-popup__item--selected' : ''}`}
                onClick={() => onSelect(item.node, false)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="suggestion-popup__item-icon">
                  {type === 'type' ? (
                    <NodeIcon icon={item.node.icon} isPage={true} size="sm" />
                  ) : (
                    <TagIcon size="sm" />
                  )}
                </span>
                <span className="suggestion-popup__item-name">
                  {item.displayName}
                </span>
              </button>
            ))}
            
            {/* Create option for type/tag mode */}
            {type !== 'link' && showCreateOption && onCreate && (
              <button
                className={`suggestion-popup__item suggestion-popup__item--create ${
                  selectedIndex === pageResults.length ? 'suggestion-popup__item--selected' : ''
                }`}
                onClick={() => onCreate(query.trim(), false)}
                onMouseEnter={() => setSelectedIndex(pageResults.length)}
              >
                <span className="suggestion-popup__item-icon">
                  <AddIcon size="sm" />
                </span>
                <span className="suggestion-popup__item-name">
                  Create "{query.trim()}"
                </span>
              </button>
            )}
          </>
        )}
      </div>
      
      <div className="suggestion-popup__footer">
        {type === 'link' ? (
          <span className="suggestion-popup__hint">
            <kbd>Enter</kbd> insert link
          </span>
        ) : (
          <>
            <span className="suggestion-popup__hint">
              <kbd>Enter</kbd> add to property
            </span>
            <span className="suggestion-popup__hint">
              <kbd>Ctrl+Enter</kbd> add inline too
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export default SuggestionPopup;
