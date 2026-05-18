/**
 * SuggestionPopup - Floating popup for various triggers
 * 
 * Shows matching nodes when user types trigger characters in the editor.
 * - + triggers class selection (nodes that are classes)
 * - # triggers tag selection (any page)
 * - [[ triggers link selection (pages first, then blocks)
 * 
 * Keyboard shortcuts for + class:
 * - Enter: Add to class_ids only (pill displayed below block)
 * - Ctrl+Enter: Add to class_ids AND show inline (inline pill in content)
 *   Note: System hides the below-block pill when class is also inline
 * 
 * Keyboard shortcuts for # tag and [[ link:
 * - Enter: Insert inline
 * 
 * Multi-select mode:
 * - Shows checkboxes next to each item
 * - Selected items are accumulated at the top
 * - Used for query filters, classes list, and tags list
 * 
 * NOTE: Moved out of core/ - has domain knowledge (Node type, useNodeSearch hook)
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import './SuggestionPopup.css';
import { useNodeSearch, usePages, useClasses, type NodeSearchMode } from '@/hooks';
import type { Node } from '@/types';
import { NodeIcon, TagIcon, AddIcon, BulletIcon, CalendarIcon } from '@/components/core/icons';
import { Checkbox } from '@/components/core/Checkbox';
import { NodeResultItem } from './NodeResultItem';
import { parseDate, generateDateUuid } from '@/utils/dateParser';
import { getOrCreateDaily, getOrCreateMonthly, getOrCreateYearly } from '@/api/nodes';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { getEffectiveIcon } from '@/utils/nodeIcon';

export type SuggestionType = 'type' | 'class' | 'tag' | 'link';

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
  onSelect: (node: Node, addInline: boolean) => void;
  /** Callback to close the popup */
  onClose: () => void;
  /** Callback to create a new item if none exist */
  onCreate?: (name: string, addInline: boolean) => void;
  /** Node ID to exclude from link results (used for non-page blocks) */
  excludeNodeId?: number;
  /** Class IDs to filter results by (nodes must have at least one of these classes) */
  classFilters?: number[];
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
  /** Show the "add inline too" option in footer (default: false) */
  showInlineOption?: boolean;
  /** Callback when a date page is selected in link mode — returns the page ID */
  onSelectDatePage?: (pageId: string, pageName: string) => void;
  /** Alt+Enter: insert as embed block instead of inline link (link mode only) */
  onSelectEmbed?: (node: Node) => void;
  /** Override the footer hint text (e.g. "insert template" instead of "insert link") */
  footerHintText?: string;
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
  classFilters,
  multiSelect = false,
  selectedIds = new Set(),
  onToggleSelect,
  headerText,
  headerIcon,
  allNodes = [],
  showInlineOption = false,
  onSelectDatePage,
  onSelectEmbed,
  footerHintText,
}: SuggestionPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);
  const [displayLimit, setDisplayLimit] = useState(10);
  
  // Map SuggestionType to NodeSearchMode
  const searchMode: NodeSearchMode = (type === 'type' || type === 'class') ? 'classes' : type === 'tag' ? 'tags' : 'all';
  
  // Use shared search hook
  const { pageResults, blockResults, isLoading, showCreateOption, hasMore } = useNodeSearch(query, {
    mode: searchMode,
    excludeNodeId,
    classFilters,
    maxResults: displayLimit,
  });
  
  // Date parsing for link mode
  const parsedDate = useMemo(() => type === 'link' ? parseDate(query) : null, [query, type]);
  const { data: allPagesForDate } = usePages({ includeChildren: true });

  // O(1) lookup maps — avoids .find() inside buildParentPath (called per result row)
  const pageById = useMemo(() => {
    const m = new Map<number, Node>();
    for (const p of allPagesForDate ?? []) m.set(p.id, p);
    return m;
  }, [allPagesForDate]);

  // Fetch all classes to show class names for pages
  const { data: allClasses = [] } = useClasses();

  const classById = useMemo(() => {
    const m = new Map<number, Node>();
    for (const c of allClasses) m.set(c.id, c as unknown as Node);
    return m;
  }, [allClasses]);
  
  // Check if the date page already exists by looking up its deterministic UUID
  const existingDateNode = useMemo(() => {
    if (!parsedDate || !allPagesForDate) return null;
    const uuid = generateDateUuid(parsedDate);
    return allPagesForDate.find(p => p.uuid === uuid) ?? null;
  }, [parsedDate, allPagesForDate]);
  
  const queryClient = useQueryClient();
  const hasDateSuggestion = parsedDate !== null && !multiSelect && !!onSelectDatePage;
  
  // Get selected nodes from allNodes for multi-select mode
  const selectedNodes = useMemo(() => {
    if (!multiSelect || selectedIds.size === 0) return [];
    return allNodes.filter(n => selectedIds.has(n.id));
  }, [multiSelect, selectedIds, allNodes]);
  
  // Build complete node list for alias resolution
  const allSearchNodes = useMemo(() => {
    return [...pageResults.map(r => r.node), ...blockResults.map(r => r.node)];
  }, [pageResults, blockResults]);
  
  // Helper to resolve aliased node name
  const getAliasedNodeName = useCallback((node: Node): string | null => {
    if (!node.aliased_id) return null;
    const aliasedNode = allSearchNodes.find(n => n.id === node.aliased_id) || allNodes.find(n => n.id === node.aliased_id);
    return aliasedNode ? (nodeNameToText(aliasedNode.name) || 'Unknown') : null;
  }, [allSearchNodes, allNodes]);
  
  // Helper to build parent page path (e.g. "Root / Parent") for a page node
  const buildParentPath = useCallback((node: Node): string => {
    if (!node.parent_id || !allPagesForDate) return '';
    const segments: string[] = [];
    let currentId: number | null = node.parent_id;
    while (currentId !== null) {
      const parent = pageById.get(currentId);
      if (!parent || !parent.is_page) break;
      segments.unshift(nodeNameToText(parent.name) || 'Untitled');
      currentId = parent.parent_id ?? null;
    }
    return segments.join(' / ');
  }, [allPagesForDate, pageById]);

  // Helper to build breadcrumb path for a block node using its page_id
  const buildBlockParentPath = useCallback((node: Node): string => {
    if (!node.page_id || !allPagesForDate) return '';
    const page = pageById.get(node.page_id);
    if (!page) return '';
    const pageName = nodeNameToText(page.name) || 'Untitled';
    const ancestors = buildParentPath(page);
    return ancestors ? `${ancestors} / ${pageName}` : pageName;
  }, [allPagesForDate, pageById, buildParentPath]);

  // Helper to get display classes for a node, excluding the system "page" class
  const getDisplayClasses = useCallback((node: Node): Array<{ id: number; name: string }> => {
    if (!node.classes || node.classes.length === 0) return [];
    return node.classes
      .map(classId => {
        const classNode = classById.get(classId);
        if (!classNode || (classNode as any).uuid === SYSTEM_CLASS_UUIDS.page) return null;
        const name = nodeNameToText(classNode.name);
        if (!name) return null;
        return { id: classId, name };
      })
      .filter((c): c is { id: number; name: string } => c !== null);
  }, [classById]);
  
  // Combined list for navigation (in multi-select mode, exclude already selected)
  const allItems = useMemo(() => {
    const items = [...pageResults, ...blockResults];
    if (multiSelect) {
      return items.filter(item => !selectedIds.has(item.node.id));
    }
    return items;
  }, [pageResults, blockResults, multiSelect, selectedIds]);
  
  // Total selectable items (date suggestion + selected at top + results + possibly create option)
  const selectedCount = multiSelect ? selectedNodes.length : 0;
  const dateSuggestionCount = hasDateSuggestion ? 1 : 0;
  const showMoreOption = hasMore && !multiSelect;
  const totalItems = dateSuggestionCount + selectedCount + allItems.length + (showCreateOption ? 1 : 0) + (showMoreOption ? 1 : 0);
  
  // Reset selection and display limit when query changes
  useEffect(() => {
    setSelectedIndex(multiSelect ? selectedCount : 0);
    setDisplayLimit(10);
  }, [query, multiSelect, selectedCount]);
  
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
        // For + class: Ctrl+Enter adds inline pill too, plain Enter just adds to class_ids
        // For # tag and [[ link: always insert inline
        const addInline = e.ctrlKey;
        
        // Alt+Enter in link mode: insert as embed block instead of inline link
        if (e.altKey && type === 'link' && onSelectEmbed) {
          const adjustedForDateEmbed = selectedIndex - dateSuggestionCount;
          const adjustedIndexEmbed = adjustedForDateEmbed - (multiSelect ? selectedCount : 0);
          if (adjustedIndexEmbed >= 0 && adjustedIndexEmbed < allItems.length) {
            onSelectEmbed(allItems[adjustedIndexEmbed].node);
          }
          break;
        }
        
        // Date suggestion at the very top
        if (hasDateSuggestion && selectedIndex === 0) {
          handleDateSelect();
          return;
        }
        
        // In multi-select mode, handle selected items at top
        const adjustedForDate = selectedIndex - dateSuggestionCount;
        if (multiSelect && adjustedForDate < selectedCount) {
          // Toggle off a selected item
          onToggleSelect?.(selectedNodes[adjustedForDate]);
          return;
        }
        
        const adjustedIndex = adjustedForDate - (multiSelect ? selectedCount : 0);
        
        if (adjustedIndex >= 0 && adjustedIndex < allItems.length) {
          // Select existing item
          if (multiSelect && onToggleSelect) {
            onToggleSelect(allItems[adjustedIndex].node);
          } else {
            onSelect(allItems[adjustedIndex].node, addInline);
          }
        } else if (showCreateOption && onCreate) {
          // Create new item
          onCreate(query.trim(), addInline);
        } else if (showMoreOption) {
          // Expand results
          setDisplayLimit(prev => prev + 20);
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
  }, [isOpen, selectedIndex, totalItems, allItems, showCreateOption, showMoreOption, query, onSelect, onCreate, onClose, multiSelect, selectedCount, selectedNodes, onToggleSelect, hasDateSuggestion, dateSuggestionCount, type, onSelectEmbed]);
  
  // Handle date suggestion selection
  const handleDateSelect = useCallback(async () => {
    if (!parsedDate || !onSelectDatePage) return;
    try {
      let dateNode: Node;
      if (existingDateNode) {
        // Page already exists, use it directly
        dateNode = existingDateNode;
      } else {
        // Create the date page via API
        if (parsedDate.type === 'day' && parsedDate.month && parsedDate.day) {
          const dateStr = `${parsedDate.year}-${String(parsedDate.month).padStart(2, '0')}-${String(parsedDate.day).padStart(2, '0')}`;
          dateNode = await getOrCreateDaily(dateStr);
        } else if (parsedDate.type === 'month' && parsedDate.month) {
          dateNode = await getOrCreateMonthly(parsedDate.year, parsedDate.month);
        } else {
          dateNode = await getOrCreateYearly(parsedDate.year);
        }
        // Invalidate caches
        queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
        queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
        queryClient.invalidateQueries({ queryKey: nodeKeys.dailyList() });
      }
      onSelectDatePage(dateNode.uuid, nodeNameToText(dateNode.name) || parsedDate.label);
    } catch (error) {
      console.error('Failed to create date page from suggestion:', error);
    }
  }, [parsedDate, onSelectDatePage, queryClient, existingDateNode]);
  
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
  
  // Adjust position to stay within viewport after render
  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    
    const popupRect = containerRef.current.getBoundingClientRect();
    const padding = 8;
    
    let { top, left } = position;
    
    // Adjust horizontal position
    if (left + popupRect.width > window.innerWidth - padding) {
      left = window.innerWidth - popupRect.width - padding;
    }
    if (left < padding) {
      left = padding;
    }
    
    // Adjust vertical position - flip above if not enough space below
    if (top + popupRect.height > window.innerHeight - padding) {
      // Try to flip above cursor
      const topAbove = position.top - popupRect.height - 24;
      if (topAbove >= padding) {
        top = topAbove;
      } else {
        // Not enough space above either, position at bottom with padding
        top = window.innerHeight - popupRect.height - padding;
      }
    }
    
    // Ensure not above top edge
    if (top < padding) {
      top = padding;
    }
    
    setAdjustedPosition({ top, left });
  }, [isOpen, position, allItems.length, selectedNodes.length, query]);
  
  if (!isOpen) return null;
  
  // Calculate indices for each section (accounting for date suggestion + selected items at top in multi-select)
  const dateIndex = 0;
  const selectedStartIndex = dateSuggestionCount;
  const pageStartIndex = dateSuggestionCount + selectedCount;
  const pageResultIds = new Set(pageResults.map(p => p.node.id));
  const blockStartIndex = dateSuggestionCount + selectedCount + (multiSelect ? allItems.filter(i => pageResultIds.has(i.node.id)).length : pageResults.length);
  const createIndex = dateSuggestionCount + selectedCount + allItems.length;
  
  // Helper to get icon for item
  const renderItemIcon = (node: Node, _isPage: boolean) => {
    if (type === 'type' || type === 'class') {
      return <NodeIcon icon={getEffectiveIcon(node, allClasses as unknown as Node[])} isPage={true} size="sm" />;
    } else if (type === 'tag') {
      return <TagIcon size="sm" />;
    } else {
      const effectiveIcon = getEffectiveIcon(node, allClasses as unknown as Node[]);
      return effectiveIcon
        ? <NodeIcon icon={effectiveIcon} isPage={false} size="sm" />
        : <BulletIcon size="sm" />;
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
      onFocus={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="suggestion-popup__header">
        {headerText ? (
          <>
            {headerIcon && <span className="suggestion-popup__icon">{headerIcon}</span>}
            <span>{headerText}</span>
          </>
        ) : type === 'type' ? (
          <>
            <span className="suggestion-popup__icon">+</span>
            <span>Add class</span>
          </>
        ) : type === 'class' ? (
          <>
            <span className="suggestion-popup__icon">+</span>
            <span>Select class</span>
          </>
        ) : type === 'tag' ? (
          <>
            <span className="suggestion-popup__icon">#</span>
            <span>Add tag</span>
          </>
        ) : (
          <>
            <span className="suggestion-popup__icon">@</span>
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
            {/* Date suggestion (link mode only, when query matches a date) */}
            {hasDateSuggestion && parsedDate && (
              <div className="suggestion-popup__section">
                <div className="suggestion-popup__section-header">Date Pages</div>
                <button
                  className={`suggestion-popup__item ${dateIndex === selectedIndex ? 'suggestion-popup__item--selected' : ''}`}
                  onClick={handleDateSelect}
                  onMouseEnter={() => setSelectedIndex(dateIndex)}
                >
                  <span className="suggestion-popup__item-icon">
                    <CalendarIcon size="sm" />
                  </span>
                  <span className="suggestion-popup__item-name">
                    {existingDateNode
                      ? `${nodeNameToText(existingDateNode.name) || parsedDate.label}`
                      : `Create ${parsedDate.type === 'day' ? 'daily' : parsedDate.type === 'month' ? 'monthly' : 'yearly'}: ${parsedDate.label}`
                    }
                  </span>
                </button>
              </div>
            )}
            
            {/* Selected items section (multi-select mode only) */}
            {multiSelect && selectedNodes.length > 0 && (
              <div className="suggestion-popup__section suggestion-popup__section--selected">
                <div className="suggestion-popup__section-header">Selected</div>
                {selectedNodes.map((node, index) => {
                  const globalIndex = selectedStartIndex + index;
                  return (
                    <NodeResultItem
                      key={`selected-${node.id}`}
                      node={node}
                      parentPath={node.is_page ? buildParentPath(node) : buildBlockParentPath(node)}
                      displayClasses={getDisplayClasses(node)}
                      isHighlighted={globalIndex === selectedIndex}
                      onClick={() => handleItemClick(node)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                      before={
                        <Checkbox
                          checked={true}
                          size="sm"
                          readOnly
                          className="suggestion-popup__checkbox"
                        />
                      }
                      iconOverride={renderItemIcon(node, node.is_page)}
                    />
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
                  const aliasedName = getAliasedNodeName(item.node);
                  return (
                    <NodeResultItem
                      key={`page-${item.node.id}`}
                      node={item.node}
                      parentPath={item.node.is_page ? buildParentPath(item.node) : ''}
                      displayClasses={item.node.is_page ? getDisplayClasses(item.node) : []}
                      isHighlighted={globalIndex === selectedIndex}
                      onClick={() => onSelect(item.node, false)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                      iconOverride={renderItemIcon(item.node, item.node.is_page)}
                      after={
                        aliasedName ? (
                          <span className="suggestion-popup__item-alias">
                            alias of: {aliasedName}
                          </span>
                        ) : undefined
                      }
                    />
                  );
                })}

                {/* Create page button at bottom of pages section */}
                {showCreateOption && onCreate && (
                  <NodeResultItem
                    key="__create-page"
                    node={{ name: `Create page "${query.trim()}"` } as Node}
                    isHighlighted={selectedIndex === createIndex}
                    onClick={() => onCreate(query.trim(), false)}
                    onMouseEnter={() => setSelectedIndex(createIndex)}
                    className="node-result-item--create"
                    iconOverride={<AddIcon size="sm" />}
                  />
                )}
              </div>
            )}
            
            {/* Blocks Section - link mode, only show if there are results */}
            {type === 'link' && !multiSelect && blockResults.length > 0 && (
              <div className="suggestion-popup__section">
                <div className="suggestion-popup__section-header">Blocks</div>
                {blockResults.map((item, index) => {
                  const globalIndex = blockStartIndex + index;
                  const aliasedName = getAliasedNodeName(item.node);
                  return (
                    <NodeResultItem
                      key={`block-${item.node.id}`}
                      node={item.node}
                      parentPath={buildBlockParentPath(item.node)}
                      displayClasses={getDisplayClasses(item.node)}
                      isHighlighted={globalIndex === selectedIndex}
                      onClick={() => onSelect(item.node, false)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                      iconOverride={(() => {
                        const effectiveIcon = getEffectiveIcon(item.node, allClasses as unknown as Node[]);
                        return effectiveIcon
                          ? <NodeIcon icon={effectiveIcon} isPage={false} size="sm" />
                          : <BulletIcon size="sm" />;
                      })()}
                      after={
                        aliasedName ? (
                          <span className="suggestion-popup__item-alias">
                            alias of: {aliasedName}
                          </span>
                        ) : undefined
                      }
                    />
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
                  const aliasedName = getAliasedNodeName(item.node);
                  return (
                    <NodeResultItem
                      key={`result-${item.node.id}`}
                      node={item.node}
                      parentPath={item.node.is_page ? buildParentPath(item.node) : buildBlockParentPath(item.node)}
                      displayClasses={getDisplayClasses(item.node)}
                      isHighlighted={globalIndex === selectedIndex}
                      onClick={() => handleItemClick(item.node)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                      before={
                        multiSelect ? (
                          <Checkbox
                            checked={isChecked}
                            size="sm"
                            readOnly
                            className="suggestion-popup__checkbox"
                          />
                        ) : undefined
                      }
                      iconOverride={renderItemIcon(item.node, item.node.is_page)}
                      after={
                        aliasedName ? (
                          <span className="suggestion-popup__item-alias">
                            alias of: {aliasedName}
                          </span>
                        ) : undefined
                      }
                    />
                  );
                })}
              </div>
            )}

            {/* Create option for type/tag mode (non-multi-select) */}
            {type !== 'link' && !multiSelect && showCreateOption && onCreate && (
              <NodeResultItem
                key="__create-type"
                node={{ name: `Create "${query.trim()}"` } as Node}
                isHighlighted={selectedIndex === pageResults.length}
                onClick={() => onCreate(query.trim(), false)}
                onMouseEnter={() => setSelectedIndex(pageResults.length)}
                className="node-result-item--create"
                iconOverride={<AddIcon size="sm" />}
              />
            )}

            {/* Create option for multi-select mode */}
            {multiSelect && showCreateOption && onCreate && (
              <NodeResultItem
                key="__create-multi"
                node={{ name: `Create "${query.trim()}"` } as Node}
                isHighlighted={selectedIndex === createIndex}
                onClick={() => onCreate(query.trim(), false)}
                onMouseEnter={() => setSelectedIndex(createIndex)}
                className="node-result-item--create"
                iconOverride={<AddIcon size="sm" />}
              />
            )}

            {/* Show more results option */}
            {showMoreOption && (
              <button
                className={`suggestion-popup__show-more ${selectedIndex === totalItems - 1 ? 'suggestion-popup__show-more--selected' : ''}`}
                onClick={() => setDisplayLimit(prev => prev + 20)}
                onMouseEnter={() => setSelectedIndex(totalItems - 1)}
              >
                Show more results
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
          <>
            <span className="suggestion-popup__hint">
              <kbd>Enter</kbd> {footerHintText || 'insert link'}
            </span>
            {onSelectEmbed && (
              <span className="suggestion-popup__hint">
                <kbd>Alt+Enter</kbd> embed
              </span>
            )}
          </>
        ) : showInlineOption ? (
          <>
            <span className="suggestion-popup__hint">
              <kbd>Enter</kbd> add class
            </span>
            <span className="suggestion-popup__hint">
              <kbd>Ctrl+Enter</kbd> add inline too
            </span>
          </>
        ) : (
          <span className="suggestion-popup__hint">
            <kbd>Enter</kbd> add to property
          </span>
        )}
      </div>
    </div>
  );
}

