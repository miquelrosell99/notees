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
 * 
 * Multi-select mode:
 * - Shows checkboxes next to each item
 * - Selected items are accumulated at the top
 * - Used for query filters, types list, and tags list
 * 
 * NOTE: Moved out of core/ - has domain knowledge (Node type, useNodeSearch hook)
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import './SuggestionPopup.css';
import { useNodeSearch, type NodeSearchMode } from '@/hooks';
import type { Node } from '@/types';
import { NodeIcon, TagIcon, AddIcon, BulletIcon } from './icons';
import { Checkbox } from './core/Checkbox';

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
  /** Enable multi-select mode with checkboxes */
  multiSelect?: boolean;
  /** Currently selected node IDs (for multi-select mode) */
  selectedIds?: Set<number>;
  /** Callback to toggle selection (for multi-select mode) */
  onToggleSelect?: (node: Node) => void;
  /** Custom header text (overrides default based on type) */
  headerText?: string;
  /** Custom header icon (overrides default based on type) */
  headerIcon?: string;
  /** All available nodes for multi-select mode (used to show selected items) */
  allNodes?: Node[];
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
  multiSelect = false,
  selectedIds = new Set(),
  onToggleSelect,
  headerText,
  headerIcon,
  allNodes = [],
}: SuggestionPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Map SuggestionType to NodeSearchMode
  const searchMode: NodeSearchMode = type === 'type' ? 'classes' : type === 'tag' ? 'tags' : 'all';
  
  // Use shared search hook
  const { pageResults, blockResults, isLoading, showCreateOption } = useNodeSearch(query, {
    mode: searchMode,
    excludeNodeId,
    maxResults: 10,
  });
  
  // Get selected nodes from allNodes for multi-select mode
  const selectedNodes = useMemo(() => {
    if (!multiSelect || selectedIds.size === 0) return [];
    return allNodes.filter(n => selectedIds.has(n.id));
  }, [multiSelect, selectedIds, allNodes]);
  
  // Combined list for navigation (in multi-select mode, exclude already selected)
  const allItems = useMemo(() => {
    const items = [...pageResults, ...blockResults];
    if (multiSelect) {
      return items.filter(item => !selectedIds.has(item.node.id));
    }
    return items;
  }, [pageResults, blockResults, multiSelect, selectedIds]);
  
  // Total selectable items (selected at top + results + possibly create option)
  const selectedCount = multiSelect ? selectedNodes.length : 0;
  const totalItems = selectedCount + allItems.length + (showCreateOption ? 1 : 0);
  
  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(multiSelect ? selectedCount : 0);
  }, [allItems.length, query, multiSelect, selectedCount]);
  
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
        
        // In multi-select mode, handle selected items at top
        if (multiSelect && selectedIndex < selectedCount) {
          // Toggle off a selected item
          onToggleSelect?.(selectedNodes[selectedIndex]);
          return;
        }
        
        const adjustedIndex = multiSelect ? selectedIndex - selectedCount : selectedIndex;
        
        if (adjustedIndex < allItems.length) {
          // Select existing item
          if (multiSelect && onToggleSelect) {
            onToggleSelect(allItems[adjustedIndex].node);
          } else {
            onSelect(allItems[adjustedIndex].node, keepInline);
          }
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
  }, [isOpen, selectedIndex, totalItems, allItems, showCreateOption, query, onSelect, onCreate, onClose, multiSelect, selectedCount, selectedNodes, onToggleSelect]);
  
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
  
  // Calculate indices for each section (accounting for selected items at top in multi-select)
  const selectedStartIndex = 0;
  const pageStartIndex = selectedCount;
  const blockStartIndex = selectedCount + (multiSelect ? allItems.filter(i => pageResults.some(p => p.node.id === i.node.id)).length : pageResults.length);
  const createIndex = selectedCount + allItems.length;
  
  // Helper to get icon for item
  const renderItemIcon = (node: Node, isPage: boolean) => {
    if (type === 'type') {
      return <NodeIcon icon={node.icon} isPage={true} size="sm" />;
    } else if (type === 'tag') {
      return <TagIcon size="sm" />;
    } else if (isPage) {
      return <NodeIcon icon={node.icon} isPage={true} size="sm" />;
    } else {
      return <BulletIcon size="sm" />;
    }
  };
  
  // Handle item click (different behavior for multi-select)
  const handleItemClick = (node: Node) => {
    if (multiSelect && onToggleSelect) {
      onToggleSelect(node);
    } else {
      onSelect(node, false);
    }
  };
  
  return (
    <div
      ref={containerRef}
      className={`suggestion-popup ${multiSelect ? 'suggestion-popup--multi-select' : ''}`}
      style={{
        position: 'fixed',
        top: adjustedPosition.top,
        left: adjustedPosition.left,
        zIndex: 1000,
      }}
    >
      <div className="suggestion-popup__header">
        {headerText ? (
          <>
            {headerIcon && <span className="suggestion-popup__icon">{headerIcon}</span>}
            <span>{headerText}</span>
          </>
        ) : type === 'type' ? (
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
        ) : allItems.length === 0 && !showCreateOption && selectedNodes.length === 0 ? (
          <div className="suggestion-popup__empty">
            {query ? 'No matches found' : 'Start typing to search'}
          </div>
        ) : (
          <>
            {/* Selected items section (multi-select mode only) */}
            {multiSelect && selectedNodes.length > 0 && (
              <div className="suggestion-popup__section suggestion-popup__section--selected">
                <div className="suggestion-popup__section-header">Selected</div>
                {selectedNodes.map((node, index) => {
                  const globalIndex = selectedStartIndex + index;
                  return (
                    <button
                      key={node.id}
                      className={`suggestion-popup__item ${globalIndex === selectedIndex ? 'suggestion-popup__item--selected' : ''}`}
                      onClick={() => handleItemClick(node)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                    >
                      <Checkbox
                        checked={true}
                        size="sm"
                        readOnly
                        className="suggestion-popup__checkbox"
                      />
                      <span className="suggestion-popup__item-icon">
                        {renderItemIcon(node, node.is_page)}
                      </span>
                      <span className="suggestion-popup__item-name">
                        {node.name || 'Untitled'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            
            {/* Pages Section - link mode */}
            {type === 'link' && !multiSelect && (pageResults.length > 0 || showCreateOption) && (
              <div className="suggestion-popup__section">
                {pageResults.length > 0 && (
                  <div className="suggestion-popup__section-header">Pages</div>
                )}
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
            
            {/* Blocks Section - link mode, only show if there are results */}
            {type === 'link' && !multiSelect && blockResults.length > 0 && (
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
            
            {/* For type/tag mode OR multi-select mode - show flat list with checkboxes */}
            {(type !== 'link' || multiSelect) && allItems.length > 0 && (
              <div className="suggestion-popup__section">
                {multiSelect && allItems.length > 0 && (
                  <div className="suggestion-popup__section-header">
                    {query ? 'Results' : 'Available'}
                  </div>
                )}
                {allItems.map((item, index) => {
                  const globalIndex = pageStartIndex + index;
                  const isChecked = multiSelect && selectedIds.has(item.node.id);
                  return (
                    <button
                      key={item.node.id}
                      className={`suggestion-popup__item ${globalIndex === selectedIndex ? 'suggestion-popup__item--selected' : ''}`}
                      onClick={() => handleItemClick(item.node)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                    >
                      {multiSelect && (
                        <Checkbox
                          checked={isChecked}
                          size="sm"
                          readOnly
                          className="suggestion-popup__checkbox"
                        />
                      )}
                      <span className="suggestion-popup__item-icon">
                        {renderItemIcon(item.node, item.node.is_page)}
                      </span>
                      <span className="suggestion-popup__item-name">
                        {item.displayName}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            
            {/* Create option for type/tag mode (non-multi-select) */}
            {type !== 'link' && !multiSelect && showCreateOption && onCreate && (
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
            
            {/* Create option for multi-select mode */}
            {multiSelect && showCreateOption && onCreate && (
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
                  Create "{query.trim()}"
                </span>
              </button>
            )}
          </>
        )}
      </div>
      
      <div className="suggestion-popup__footer">
        {multiSelect ? (
          <span className="suggestion-popup__hint">
            Click to select/deselect
          </span>
        ) : type === 'link' ? (
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
