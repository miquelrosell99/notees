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
import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, type RefObject } from 'react';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Spinner } from '@/components/ui/Spinner';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import './SuggestionPopup.css';
import { useNodeSearch, usePages, useClasses, type NodeSearchMode } from '@/features/content';
import { useOverlaySurface } from '@/hooks/useOverlaySurface';
import { parseQueryWithFilters } from '@/utils/searchFilters';
import type { Node } from '@/types';
import { NodeIcon, TagIcon, AddIcon, BulletIcon, CalendarIcon } from '@/components/ui/icons';
import { Checkbox } from '@/components/ui/Checkbox';
import { NodeResultItem } from './NodeResultItem';
import { parseDate, generateDateUuid } from '@/utils/dateParser';
import {
  getOrCreateDailyNote,
  getOrCreateMonthlyNote,
  getOrCreateYearlyNote,
} from '@/features/content/hooks/useNodeDateQueries';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { nodeNameToText } from '@/features/queries';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import { getEffectiveIcon } from '@/utils/nodeIcon';

export type SuggestionType = 'type' | 'class' | 'tag' | 'link';

/** Gap between the anchor element and the popup. */
const POPUP_GAP = 4;
/** Minimum clearance from the popup to the viewport edge. */
const VIEWPORT_PADDING = 8;

export interface SuggestionPopupProps {
  /** Whether the popup is visible */
  isOpen: boolean;
  /** The search query (text after @ or #) */
  query: string;
  /** Type of suggestion (type, tag, or link) */
  type: SuggestionType;
  /** Anchor element the popup positions itself against */
  anchorRef: RefObject<HTMLElement | null>;
  /** Callback when an item is selected */
  onSelect: (node: Node, addInline: boolean) => void;
  /** Callback to close the popup */
  onClose: () => void;
  /** Callback to create a new item if none exist */
  onCreate?: (name: string, addInline: boolean) => void;
  /** Node UUID to exclude from link results (used for non-page blocks) */
  excludeNodeId?: string;
  /** Class IDs to filter results by (nodes must have at least one of these classes) */
  classFilters?: string[];
  /** Enable multi-select mode with checkboxes */
  multiSelect?: boolean;
  /** Currently selected node UUIDs (for multi-select mode) */
  selectedIds?: Set<string>;
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
  anchorRef,
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
  const [displayLimit, setDisplayLimit] = useState(10);

  // Register with the global overlay stack so Escape closes this popup
  // even when focus remains in the editor.
  useOverlaySurface({
    type: 'popup',
    enabled: isOpen,
    onClose,
  });

  // Trap focus (Tab) while the popup is presented as a modal, but do not
  // auto-focus so the user can keep typing in the editor input.
  // Escape handling is owned by the global overlay stack.
  useFocusTrap(containerRef, {
    enabled: isOpen,
    onEscape: undefined,
    autoFocus: false,
    restoreFocus: false,
  });
  
  // Map SuggestionType to NodeSearchMode
  const searchMode: NodeSearchMode = (type === 'type' || type === 'class') ? 'classes' : type === 'tag' ? 'tags' : 'all';

  // Fetch all classes early (needed for filter extraction)
  const { data: allClasses = [] } = useClasses();

  // Parse query for filters on the fly
  const parsedFilters = useMemo(() => parseQueryWithFilters(query, []), [query]);

  // Extract inline filters from query using regex
  const extractedFilters = useMemo(() => {
    const filters: {
      nodeUuid?: string;
      isPage?: boolean;
      isClass?: boolean;
      isDaily?: boolean;
      classFilterIds: string[];
    } = { classFilterIds: [] };

    const uuidMatch = query.match(/\buuid:([^\s]+)/);
    if (uuidMatch) filters.nodeUuid = uuidMatch[1];

    if (/\bis_page:true\b/i.test(query)) filters.isPage = true;
    else if (/\bis_page:false\b/i.test(query)) filters.isPage = false;
    if (/\bis_class:true\b/i.test(query)) filters.isClass = true;
    else if (/\bis_class:false\b/i.test(query)) filters.isClass = false;
    if (/\bis_daily:true\b/i.test(query)) filters.isDaily = true;
    else if (/\bis_daily:false\b/i.test(query)) filters.isDaily = false;

    const classRegex = /\bclass:([^\s]+)/g;
    let m;
    while ((m = classRegex.exec(query)) !== null) {
      const name = m[1].toLowerCase();
      const matched = allClasses.find(c => nodeNameToText(c.name).toLowerCase().includes(name));
      if (matched && !filters.classFilterIds.includes(matched.uuid)) {
        filters.classFilterIds.push(matched.uuid);
      }
    }

    return filters;
  }, [query, allClasses]);

  // Clean query for searching (remove filter syntax)
  const searchQuery = useMemo(() => {
    return query
      .replace(/\bclass:[^\s]+\b/g, '')
      .replace(/\buuid:[^\s]+\b/g, '')
      .replace(/\bis_page:(?:true|false)\b/gi, '')
      .replace(/\bis_class:(?:true|false)\b/gi, '')
      .replace(/\bis_daily:(?:true|false)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }, [query]);

  // Use shared search hook with extracted filters
  const { pageResults, blockResults, isLoading, showCreateOption, hasMore } = useNodeSearch(searchQuery, {
    mode: searchMode,
    excludeNodeId,
    classFilters: [...(classFilters ?? []), ...extractedFilters.classFilterIds],
    maxResults: displayLimit,
    nodeUuid: extractedFilters.nodeUuid ?? parsedFilters.uuidSearch ?? undefined,
    isPage: extractedFilters.isPage,
    isClass: extractedFilters.isClass,
    isDaily: extractedFilters.isDaily,
  });

  // Date parsing for link mode
  const parsedDate = useMemo(() => type === 'link' ? parseDate(query) : null, [query, type]);
  const { data: allPagesForDate } = usePages({ includeChildren: true });

  // O(1) lookup maps — avoids .find() inside buildParentPath (called per result row)
  const pageById = useMemo(() => {
    const m = new Map<string, Node>();
    for (const p of allPagesForDate ?? []) m.set(p.uuid, p);
    return m;
  }, [allPagesForDate]);

  const classById = useMemo(() => {
    const m = new Map<string, Node>();
    for (const c of allClasses) m.set(c.uuid, c as unknown as Node);
    return m;
  }, [allClasses]);
  
  // Check if the date page already exists by looking up its deterministic UUID
  const existingDateNode = useMemo(() => {
    if (!parsedDate || !allPagesForDate) return null;
    const datePageUuid = generateDateUuid(parsedDate);
    return allPagesForDate.find(p => p.uuid === datePageUuid) ?? null;
  }, [parsedDate, allPagesForDate]);
  
  const workspaceUuid = useCurrentWorkspaceUuid();
  const hasDateSuggestion = parsedDate !== null && !multiSelect && !!onSelectDatePage;
  
  // Get selected nodes from allNodes for multi-select mode
  const selectedNodes = useMemo(() => {
    if (!multiSelect || selectedIds.size === 0) return [];
    return allNodes.filter(n => selectedIds.has(n.uuid));
  }, [multiSelect, selectedIds, allNodes]);
  
  // Build complete node list for alias resolution
  const allSearchNodes = useMemo(() => {
    return [...pageResults.map(r => r.node), ...blockResults.map(r => r.node)];
  }, [pageResults, blockResults]);
  
  // Helper to resolve aliased node name
  const getAliasedNodeName = useCallback((node: Node): string | null => {
    if (!node.aliased_uuid) return null;
    const aliasedNode = allSearchNodes.find(n => n.uuid === node.aliased_uuid) || allNodes.find(n => n.uuid === node.aliased_uuid);
    return aliasedNode ? (nodeNameToText(aliasedNode.name) || null) : null;
  }, [allSearchNodes, allNodes]);
  
  // Helper to build parent page path (e.g. "Root / Parent") for a page node
  const buildParentPath = useCallback((node: Node): string => {
    if (!node.parent_uuid || !allPagesForDate) return '';
    const segments: string[] = [];
    let currentId: string | null = node.parent_uuid;
    while (currentId !== null) {
      const parent = pageById.get(currentId);
      if (!parent || !parent.is_page) break;
      segments.unshift(nodeNameToText(parent.name) || 'Untitled');
      currentId = parent.parent_uuid ?? null;
    }
    return segments.join(' / ');
  }, [allPagesForDate, pageById]);

  // Helper to build breadcrumb path for a block node using its page_id
  const buildBlockParentPath = useCallback((node: Node): string => {
    if (!node.page_uuid || !allPagesForDate) return '';
    const page = pageById.get(node.page_uuid);
    if (!page) return '';
    const pageName = nodeNameToText(page.name) || 'Untitled';
    const ancestors = buildParentPath(page);
    return ancestors ? `${ancestors} / ${pageName}` : pageName;
  }, [allPagesForDate, pageById, buildParentPath]);

  // Helper to get display classes for a node, excluding the system "page" class
  const getDisplayClasses = useCallback((node: Node): Array<{ nodeUuid: string; name: string }> => {
    if (!node.classes_uuid || node.classes_uuid.length === 0) return [];
    return node.classes_uuid
      .map(classUuid => {
        const classNode = classById.get(classUuid);
        if (!classNode || classNode.uuid === SYSTEM_CLASS_UUIDS.page) return null;
        const name = nodeNameToText(classNode.name);
        if (!name) return null;
        return { nodeUuid: classUuid, name };
      })
      .filter((c): c is { nodeUuid: string; name: string } => c !== null);
  }, [classById]);
  
  // Combined list for navigation (in multi-select mode, exclude already selected)
  const allItems = useMemo(() => {
    const items = [...pageResults, ...blockResults];
    if (multiSelect) {
      return items.filter(item => !selectedIds.has(item.node.uuid));
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
      setDisplayLimit(10);;
  }, [query, multiSelect, selectedCount]);
  
  // Handle date suggestion selection
  const handleDateSelect = useCallback(async () => {
    if (!parsedDate || !onSelectDatePage || !workspaceUuid) return;
    const store = getWorkspaceStore(workspaceUuid);
    if (!store) return;
    try {
      let dateNode: Node;
      if (existingDateNode) {
        // Page already exists, use it directly
        dateNode = existingDateNode;
      } else {
        // Create the date page in the local-first core store
        if (parsedDate.type === 'day' && parsedDate.month && parsedDate.day) {
          const dateStr = `${parsedDate.year}-${String(parsedDate.month).padStart(2, '0')}-${String(parsedDate.day).padStart(2, '0')}`;
          dateNode = getOrCreateDailyNote(store, dateStr);
        } else if (parsedDate.type === 'month' && parsedDate.month) {
          dateNode = getOrCreateMonthlyNote(store, parsedDate.year, parsedDate.month);
        } else {
          dateNode = getOrCreateYearlyNote(store, parsedDate.year);
        }
      }
      onSelectDatePage(dateNode.uuid, nodeNameToText(dateNode.name) || parsedDate.label);
    } catch (error) {
      console.error('Failed to create date page from suggestion:', error);
    }
  }, [parsedDate, onSelectDatePage, existingDateNode, workspaceUuid]);
  
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
        
      case 'Enter': {
        e.preventDefault();
        e.stopPropagation();
        // For + class: Ctrl+Enter adds inline pill too, plain Enter just adds to class_ids
        // For # tag and [[ link: always insert inline
        const addInline = e.ctrlKey || e.metaKey;
        
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
      }
        
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
    }
  }, [isOpen, selectedIndex, totalItems, allItems, showCreateOption, showMoreOption, query, onSelect, onCreate, onClose, multiSelect, selectedCount, selectedNodes, onToggleSelect, hasDateSuggestion, dateSuggestionCount, type, onSelectEmbed, handleDateSelect]);
  
  // Attach keyboard listener
  useEffect(() => {
    if (!isOpen) return;

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
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
  
  // Position the popup against its anchor with Floating UI and keep it
  // anchored on scroll/resize and while results change its size (autoUpdate's
  // ResizeObserver re-runs the compute). Hidden until the first compute so it
  // never flashes at an unpositioned spot; position styles are written
  // straight to the element, so repositioning never goes through React renders.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const floating = containerRef.current;
    const reference = anchorRef.current;
    if (!floating) return;
    if (!reference) {
      floating.style.visibility = 'visible';
      return;
    }

    floating.style.visibility = 'hidden';

    const update = () => {
      computePosition(reference, floating, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [
          offset(POPUP_GAP),
          flip({ padding: VIEWPORT_PADDING, fallbackPlacements: ['top-start'] }),
          shift({ padding: VIEWPORT_PADDING, crossAxis: true }),
        ],
      }).then(({ x, y }) => {
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.style.visibility = 'visible';
      });
    };

    update();
    return autoUpdate(reference, floating, update);
  }, [isOpen, anchorRef]);

  if (!isOpen) return null;

  // Determine if any inline filters are active
  const hasActiveFilters = extractedFilters.nodeUuid !== undefined ||
    extractedFilters.isPage !== undefined ||
    extractedFilters.isClass !== undefined ||
    extractedFilters.isDaily !== undefined ||
    extractedFilters.classFilterIds.length > 0 ||
    parsedFilters.uuidSearch !== null;

  const filterHintParts: string[] = [];
  if (extractedFilters.nodeUuid ?? parsedFilters.uuidSearch) filterHintParts.push('UUID');
  if (extractedFilters.isPage !== undefined) filterHintParts.push('Page');
  if (extractedFilters.isClass !== undefined) filterHintParts.push('Class');
  if (extractedFilters.isDaily !== undefined) filterHintParts.push('Daily');
  if (extractedFilters.classFilterIds.length > 0) filterHintParts.push('Class');

  // Calculate indices for each section (accounting for date suggestion + selected items at top in multi-select)
  const dateIndex = 0;
  const selectedStartIndex = dateSuggestionCount;
  const pageStartIndex = dateSuggestionCount + selectedCount;
  const pageResultIds = new Set(pageResults.map(p => p.node.uuid));
  const blockStartIndex = dateSuggestionCount + selectedCount + (multiSelect ? allItems.filter(i => pageResultIds.has(i.node.uuid)).length : pageResults.length);
  const createIndex = dateSuggestionCount + selectedCount + allItems.length;
  
  // Helper to get icon for item
  const renderItemIcon = (node: Node) => {
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
      role="dialog"
      aria-modal="true"
      aria-label="Suggestions"
      className={`suggestion-popup ${multiSelect ? 'suggestion-popup--multi-select' : ''}`}
      style={{
        position: 'fixed',
        // top/left are set imperatively by Floating UI so repositioning
        // never goes through React renders
        zIndex: 'var(--z-1000)',
      }}
      onFocus={(e) => e.stopPropagation()}
      onMouseDownCapture={(e) => e.stopPropagation()}
      onClickCapture={(e) => e.stopPropagation()}
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

      {hasActiveFilters && (
        <div className="suggestion-popup__filter-hint">
          {filterHintParts.length > 0
            ? `${filterHintParts.join(', ')} filter active`
            : 'Filter active'}
        </div>
      )}

      <div className="suggestion-popup__list">
        {isLoading && query.length > 0 ? (
          <div className="suggestion-popup__loading"><Spinner size="sm" label="Searching..." /></div>
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
                      key={`selected-${node.uuid}`}
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
                      iconOverride={renderItemIcon(node)}
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
                      key={`page-${item.node.uuid}`}
                      node={item.node}
                      parentPath={item.node.is_page ? buildParentPath(item.node) : ''}
                      displayClasses={item.node.is_page ? getDisplayClasses(item.node) : []}
                      isHighlighted={globalIndex === selectedIndex}
                      onClick={() => onSelect(item.node, false)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                      iconOverride={renderItemIcon(item.node)}
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
                      key={`block-${item.node.uuid}`}
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
                  const isChecked = multiSelect && selectedIds.has(item.node.uuid);
                  const aliasedName = getAliasedNodeName(item.node);
                  return (
                    <NodeResultItem
                      key={`result-${item.node.uuid}`}
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
                      iconOverride={renderItemIcon(item.node)}
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

