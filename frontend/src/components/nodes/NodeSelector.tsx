/**
 * NodeSelector - Universal node selection component
 * 
 * Supports three trigger modes:
 * - 'pill-row': Row of node pills with add button (default, for tags/types/classes)
 * - 'select': Dropdown trigger with SelectTrigger (for property values, single/multi)
 * - 'inline': Always-expanded search + results list, no toggle (for embedded pickers)
 * 
 * All modes use the shared NodeResultItem component so the result list UI is
 * consistent everywhere nodes are selected.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useQueries } from '@tanstack/react-query';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { NodeRef } from './NodeRef';
import { AddIcon, NodeIcon } from '../core/icons';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { Checkbox } from '../core/Checkbox';
import { SearchField } from '../core/SearchField';
import { NodeResultItem } from './NodeResultItem';
import { Button } from '../core/Button';
import { Card } from '../core/Card';
import { SelectTrigger, type SelectTriggerSize } from '../core/SelectTrigger';
import { mdiPlus, mdiChevronDown } from '@mdi/js';
import Icon from '@mdi/react';
import { useNodeSearch, usePages, useClasses, useCreateNode, usePageClass, useClassClass, type NodeSearchMode, nodeKeys } from '@/hooks';
import * as nodesApi from '@/api/nodes';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { SYSTEM_CLASS_UUIDS } from '@/constants';
import type { Node } from '@/types';
import './NodeSelector.css';

type TriggerMode = 'pill-row' | 'select' | 'inline';

interface NodeSelectorProps {
  /** The nodes to display as pills (or selected values in 'select' mode) */
  nodes?: Node[];
  /** Alternative: provide node IDs instead of Node objects ('select' mode will fetch them) */
  value?: number | number[] | null;
  /** Search mode for the picker - determines what types of nodes to show */
  searchMode?: NodeSearchMode;
  /** Class IDs to filter search results by (nodes must have at least one of these classes) */
  classFilters?: number[];
  /** Trigger style: 'pill-row' (default) or 'select' (dropdown) */
  trigger?: TriggerMode;
  /** Whether multi-select is enabled (only applies to 'select' mode) */
  multi?: boolean;
  /** Placeholder text for empty state */
  placeholder?: string;
  /** Placeholder text for empty state add button (pill-row mode) */
  emptyText?: string;
  /** Placeholder for search input */
  searchPlaceholder?: string;
  /** Callback when clicking a pill (navigate) */
  onNodeClick?: (node: Node) => void;
  /** Callback when removing a node (if provided, shows remove button on pills) */
  onRemove?: (node: Node) => void;
  /** Callback when changing a node's color via right-click (if provided, enables color picker) */
  onColorChange?: (node: Node, color: string | null) => void;
  /** Callback when adding a node from the picker (single-select: replaces; multi-select: adds) */
  onAdd?: (node: Node) => void;
  /** Callback when value changes (for 'select' mode with value prop) */
  onChange?: (value: number | number[] | null) => void;
  /** Callback when creating a new node (if provided, overrides built-in create) */
  onCreateNew?: (name: string) => void | Promise<Node>;
  /** Whether to show the "Create" option when no match is found (default: true for page/class/tag modes) */
  allowCreate?: boolean;
  /** Callback when converting an existing page to a class (if provided, shows convert option for non-class pages) */
  onConvertToClass?: (node: Node) => void;
  /** Callback when clearing all selections ('select' mode only) */
  onClearAll?: () => void;
  /** Function to determine if a node can be removed (default: all can be removed) */
  canRemove?: (node: Node) => boolean;
  /** Function to determine if a node can be added (filters search results) */
  canAdd?: (node: Node) => boolean;
  /** Node ID to exclude from search results (e.g., current node) */
  excludeNodeId?: number;
  /** Whether pills are read-only (hides remove button) */
  readOnly?: boolean;
  /** Initial search query to pre-fill when the picker opens */
  initialSearchQuery?: string;
  /** Size variant for select trigger (default: 'md') */
  size?: SelectTriggerSize;
  /** Additional CSS class */
  className?: string;
}

export function NodeSelector({
  nodes: nodesProp,
  value,
  searchMode = 'pages',
  classFilters,
  trigger = 'pill-row',
  multi = false,
  placeholder = 'Select node...',
  emptyText = 'Add',
  searchPlaceholder = 'Search...',
  onNodeClick,
  onRemove,
  onColorChange,
  onAdd,
  onChange,
  onCreateNew,
  allowCreate,
  onConvertToClass,
  onClearAll,
  canRemove,
  canAdd,
  excludeNodeId,
  readOnly = false,
  initialSearchQuery = '',
  size,
  className = '',
}: NodeSelectorProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const arrowBtnRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Compute value IDs for fetching and exclusion
  const valueIds = useMemo(() => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }, [value]);

  // Fetch each node by ID individually - reliable regardless of pagination
  const nodeQueries = useQueries({
    queries: nodesProp ? [] : valueIds.map((nodeId) => ({
      queryKey: nodeKeys.detail(nodeId, { include_children: false }),
      queryFn: () => nodesApi.getNode(nodeId, { include_children: false }),
      staleTime: 5 * 60 * 1000,
      enabled: !!nodeId,
    })),
  });

  // Resolve nodes from individual queries
  const resolvedNodesFromValue = useMemo(() => {
    return nodeQueries
      .map(query => query.data)
      .filter((n): n is Node => n !== undefined);
  }, [nodeQueries]);

  // Use either nodes prop or resolved nodes from value
  const nodes = nodesProp ?? resolvedNodesFromValue;

  // Use shared search hook (same as SuggestionPopup)
  const { allResults, isLoading, showCreateOption: searchShowCreate } = useNodeSearch(searchQuery, {
    mode: searchMode,
    classFilters,
    excludeNodeId,
    maxResults: trigger === 'select' ? 15 : 10,
  });

  // Secondary search for page conversion candidates (always called to respect hooks rules;
  // results only used when onConvertToClass is provided and there's an active query)
  const { allResults: pageConvertResults } = useNodeSearch(searchQuery, {
    mode: 'pages',
    maxResults: 5,
    excludeNodeId,
  });

  // For parent hierarchy display on page items
  const { data: allPages = [] } = usePages();
  const { data: allClasses = [] } = useClasses();

  // Built-in create support — hooks must be called unconditionally
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();

  // Resolve whether create is enabled: default true for page/class/tag modes, false for blocks
  const createEnabled = allowCreate ?? (searchMode !== 'blocks');

  // Internal default create handler based on searchMode
  const defaultCreateNew = useCallback(async (name: string): Promise<Node> => {
    const classes: number[] = [];
    if (pageClassId) classes.push(pageClassId);
    if ((searchMode === 'classes') && classClassId) classes.push(classClassId);
    return new Promise((resolve, reject) => {
      createNodeMutation.mutate({ name, classes }, {
        onSuccess: resolve,
        onError: reject,
      });
    });
  }, [createNodeMutation, pageClassId, classClassId, searchMode]);

  // Effective create handler: external overrides internal
  const effectiveCreateNew = onCreateNew ?? (createEnabled ? defaultCreateNew : undefined);

  // Convert search results to Node array
  const searchResults = useMemo(() => {
    return allResults.map(r => r.node);
  }, [allResults]);

  // Filter out already assigned nodes and nodes that cannot be added
  // Use raw value IDs (not resolved nodes) to ensure exclusion works even when nodes haven't loaded
  const assignedIds = useMemo(() => {
    const ids = new Set(nodes.map(n => n.id));
    // Also include raw value IDs to cover unresolved nodes
    for (const id of valueIds) {
      ids.add(id);
    }
    return ids;
  }, [nodes, valueIds]);
  
  const filteredResults = useMemo(() => {
    return searchResults
      .filter(node => !assignedIds.has(node.id))
      .filter(node => !canAdd || canAdd(node));
  }, [searchResults, assignedIds, canAdd]);

  // Only show create option if a create handler is available and there's a query
  const showCreateOption = effectiveCreateNew && searchShowCreate && searchQuery.trim().length > 0;

  // Non-class pages matching the search query, offered as "convert to class" candidates
  const convertCandidates = useMemo(() => {
    if (!onConvertToClass || !searchQuery.trim()) return [];
    return pageConvertResults
      .map(r => r.node)
      .filter(n => !n.is_class && !assignedIds.has(n.id));
  }, [onConvertToClass, searchQuery, pageConvertResults, assignedIds]);

  // For multi-select dropdown: selected nodes first, then unselected search results
  const multiDropdownItems = useMemo(() => {
    if (!multi) return [];
    // Get all search results that can be added (without excluding assigned ones)
    const allSearchable = searchResults.filter(node => !canAdd || canAdd(node));
    const selected = allSearchable.filter(node => assignedIds.has(node.id));
    const unselected = allSearchable.filter(node => !assignedIds.has(node.id));
    // Also include assigned nodes that aren't in search results (when no search query)
    const searchIds = new Set(allSearchable.map(n => n.id));
    const assignedNotInSearch = nodes.filter(n => !searchIds.has(n.id));
    return [...assignedNotInSearch, ...selected, ...unselected];
  }, [multi, searchResults, assignedIds, canAdd, nodes]);

  // Total selectable items
  const totalItems = multi
    ? multiDropdownItems.length + (showCreateOption ? 1 : 0)
    : filteredResults.length + convertCandidates.length + (showCreateOption ? 1 : 0);

  // Position menu for 'select' single mode with viewport flip
  const menuPosition = useViewportFlip(
    containerRef,
    trigger === 'select' && !multi && isPickerOpen,
    { maxHeight: 320, includeWidth: true, minWidth: 240 },
  );

  // Position menu for 'select' multi mode - anchored to arrow button, right-aligned
  const [multiMenuPos, setMultiMenuPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  useEffect(() => {
    if (!(trigger === 'select' && multi && isPickerOpen) || !arrowBtnRef.current) {
      setMultiMenuPos(null);
      return;
    }
    const rect = arrowBtnRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const dropdownWidth = 280;
    const gap = 4;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const maxPopupHeight = 320;

    let top: number;
    let maxHeight: number;
    if (spaceBelow >= maxPopupHeight || spaceBelow > spaceAbove) {
      top = rect.bottom + window.scrollY + gap;
      maxHeight = Math.min(maxPopupHeight, spaceBelow - gap * 2);
    } else {
      maxHeight = Math.min(maxPopupHeight, spaceAbove - gap * 2);
      top = rect.top + window.scrollY - maxHeight - gap;
    }

    // Right-align to arrow button
    let left = rect.right + window.scrollX - dropdownWidth;
    if (left < 16) left = 16;
    if (left + dropdownWidth > viewportWidth - 16) {
      left = viewportWidth - dropdownWidth - 16;
    }

    setMultiMenuPos({ top, left, maxHeight });
  }, [trigger, multi, isPickerOpen]);

  // Position for 'pill-row' mode (simple fixed positioning)
  useEffect(() => {
    if (trigger === 'pill-row' && isPickerOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPickerPos({ top: rect.bottom + 4, left: rect.left });
    } else if (!isPickerOpen) {
      setPickerPos(null);
    }
  }, [isPickerOpen, trigger]);

  // Close picker when clicking outside
  useEffect(() => {
    if (!isPickerOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const pickerElement = trigger === 'select' ? menuRef.current : pickerRef.current;
      const triggerElement = trigger === 'select' ? containerRef.current : buttonRef.current;
      
      if (
        pickerElement && !pickerElement.contains(target) &&
        triggerElement && !triggerElement.contains(target)
      ) {
        setIsPickerOpen(false);
        setSearchQuery('');
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPickerOpen(false);
        setSearchQuery('');
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isPickerOpen, trigger]);

  // Focus search input when picker opens
  // Include pickerPos in deps because in pill-row mode the picker only renders
  // after pickerPos is set (one render cycle after isPickerOpen becomes true),
  // so the ref is null on the first run.
  useEffect(() => {
    if (isPickerOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isPickerOpen, pickerPos, menuPosition, multiMenuPos]);

  const handleAdd = useCallback((node: Node) => {
    // Prevent adding duplicates
    if (assignedIds.has(node.id)) return;
    
    if (onChange) {
      // Value-based API: update value
      const newValue = multi
        ? [...(Array.isArray(value) ? value : []), node.id]
        : node.id;
      onChange(newValue);
    } else {
      // Node-based API: call onAdd
      onAdd?.(node);
    }
    
    if (!multi || trigger === 'pill-row') {
      setIsPickerOpen(false);
      setSearchQuery('');
    }
  }, [onChange, onAdd, multi, trigger, value, assignedIds]);

  const handleRemove = useCallback((node: Node) => {
    if (onChange) {
      // Value-based API: update value
      if (multi && Array.isArray(value)) {
        onChange(value.filter(id => id !== node.id));
      } else {
        onChange(null);
      }
    } else {
      // Node-based API: call onRemove
      onRemove?.(node);
    }
  }, [onChange, onRemove, multi, value]);

  // Toggle handler for multi-select dropdown: add if not selected, remove if selected
  const handleToggle = useCallback((node: Node) => {
    if (assignedIds.has(node.id)) {
      handleRemove(node);
    } else {
      handleAdd(node);
    }
  }, [assignedIds, handleAdd, handleRemove]);

  const handleCreateNew = useCallback(async () => {
    if (!searchQuery.trim() || !effectiveCreateNew) return;
    const result = effectiveCreateNew(searchQuery.trim());
    
    // If onCreate returns a promise (creates node), wait for it and add it
    if (result instanceof Promise) {
      try {
        const newNode = await result;
        if (newNode) {
          handleAdd(newNode);
        }
      } catch (error) {
        console.error('Failed to create node:', error);
      }
    }
    
    setIsPickerOpen(false);
    setSearchQuery('');
  }, [searchQuery, effectiveCreateNew, handleAdd]);

  const handleClearAll = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onChange) {
      onChange(multi ? [] : null);
    } else {
      onClearAll?.();
    }
    setIsPickerOpen(false);
  }, [onChange, onClearAll, multi]);

  // Keyboard list navigation
  const handleSelectByIndex = useCallback((index: number) => {
    if (multi) {
      if (index < multiDropdownItems.length) {
        handleToggle(multiDropdownItems[index]);
      } else if (showCreateOption) {
        handleCreateNew();
      }
    } else {
      if (index < filteredResults.length) {
        handleAdd(filteredResults[index]);
      } else if (index < filteredResults.length + convertCandidates.length) {
        const convertNode = convertCandidates[index - filteredResults.length];
        onConvertToClass?.(convertNode);
        setIsPickerOpen(false);
        setSearchQuery('');
      } else if (showCreateOption) {
        handleCreateNew();
      }
    }
  }, [multi, multiDropdownItems, filteredResults, convertCandidates, showCreateOption, handleAdd, handleToggle, handleCreateNew, onConvertToClass]);

  const handleClosePicker = useCallback(() => {
    setIsPickerOpen(false);
    setSearchQuery('');
  }, []);

  // Build parent page path (e.g. "Root / Parent /") for a page node
  const buildParentPath = useCallback((node: Node): string => {
    if (!node.parent_id) return '';
    const segments: string[] = [];
    let currentId: number | null = node.parent_id;
    while (currentId !== null) {
      const parent = allPages.find(p => p.id === currentId && p.is_page);
      if (!parent) break;
      segments.unshift(nodeNameToText(parent.name) || 'Untitled');
      currentId = parent.parent_id ?? null;
    }
    if (segments.length === 0) return '';
    const fullPath = segments.join(' / ') + ' /';
    if (fullPath.length <= 36) return fullPath;
    const parts = [...segments];
    while (parts.length > 1) {
      parts.shift();
      const candidate = '.../ ' + parts.join(' / ') + ' /';
      if (candidate.length <= 36) return candidate;
    }
    const last = parts[0];
    return '.../ ' + (last.length > 26 ? last.slice(0, 23) + '...' : last) + ' /';
  }, [allPages]);

  // Get display classes for a node, excluding the system "page" class
  const getDisplayClasses = useCallback((node: Node): Array<{ id: number; name: string }> => {
    if (!node.classes || node.classes.length === 0) return [];
    return node.classes
      .map(classId => {
        const classNode = allClasses.find(c => c.id === classId);
        if (!classNode || classNode.uuid === SYSTEM_CLASS_UUIDS.page) return null;
        const name = nodeNameToText(classNode.name);
        if (!name) return null;
        return { id: classId, name };
      })
      .filter((c): c is { id: number; name: string } => c !== null);
  }, [allClasses]);

  // 'inline' mode is always active; other modes are active when picker is open
  const isNavActive = trigger === 'inline' || isPickerOpen;

  const { selectedIndex, setSelectedIndex, handleKeyDown } = useKeyboardListNav({
    totalItems,
    onSelect: handleSelectByIndex,
    onClose: handleClosePicker,
    isOpen: isNavActive,
  });

  // 'select' mode: render SelectTrigger with portal dropdown
  if (trigger === 'select') {
    const hasValue = nodes.length > 0;
    
    // Read-only view
    if (readOnly) {
      return (
        <div className={`node-selector node-selector--select node-selector--readonly ${className}`}>
          {hasValue ? (
            <div className="node-selector__selected-list">
              {nodes.map(node => (
                <button
                  key={node.id}
                  className="node-selector__chip node-selector__chip--readonly"
                  onClick={() => onNodeClick?.(node)}
                >
                  <NodeIcon icon={node.icon} isPage={node.is_page} size="xs" />
                  <span>{nodeNameToText(node.name) || 'Untitled'}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="node-selector__placeholder">Empty</span>
          )}
        </div>
      );
    }
    
    return (
      <div className={`node-selector node-selector--select ${multi ? 'node-selector--select-multi' : ''} ${className}`} ref={containerRef}>
        {multi ? (
          // Multi-select: flat layout with pills + separate arrow button
          <div className="node-selector__multi-trigger">
            <div className="node-selector__selected-pills">
              {nodes.map(node => (
                <NodeRef
                  key={node.id}
                  nodeId={node.id}
                  onClick={() => onNodeClick?.(node)}
                  onRemove={readOnly ? undefined : () => handleRemove(node)}
                  readOnly={readOnly}
                />
              ))}
              {nodes.length === 0 && (
                <span className="node-selector__placeholder">{placeholder}</span>
              )}
            </div>
            {!readOnly && (
              <button
                ref={arrowBtnRef}
                type="button"
                className={`node-selector__arrow-btn ${isPickerOpen ? 'node-selector__arrow-btn--open' : ''}`}
                onClick={() => setIsPickerOpen(prev => !prev)}
                aria-label="Toggle picker"
                aria-expanded={isPickerOpen}
              >
                <Icon path={mdiChevronDown} size={0.7} />
              </button>
            )}
          </div>
        ) : (
          // Single-select: use SelectTrigger as before
          <SelectTrigger
            isOpen={isPickerOpen}
            disabled={readOnly}
            clearable={!readOnly && hasValue}
            hasValue={hasValue}
            size={size}
            onClick={() => !readOnly && setIsPickerOpen(prev => !prev)}
            onClear={readOnly ? undefined : handleClearAll}
          >
            {hasValue ? (
              (() => {
                const node = nodes[0];
                const displayCls = node ? getDisplayClasses(node) : [];
                return (
                  <span className="node-selector__single-value">
                    <NodeIcon icon={getEffectiveIcon(node, allClasses) ?? node?.icon} isPage={node?.is_page} size="xs" />
                    <span className="node-selector__single-value-name">
                      {nodeNameToText(node?.name) || 'Untitled'}
                    </span>
                    {displayCls.length > 0 && (
                      <span className="node-selector__single-value-classes">
                        {displayCls.map(cls => (
                          <span key={cls.id} className="node-selector__single-value-class-pill">{cls.name}</span>
                        ))}
                      </span>
                    )}
                  </span>
                );
              })()
            ) : (
              <span className="node-selector__placeholder">{placeholder}</span>
            )}
          </SelectTrigger>
        )}
        
        {/* Dropdown Menu for multi-select - Rendered in Portal */}
        {multi && isPickerOpen && multiMenuPos && createPortal(
          <Card
            ref={menuRef}
            className="node-selector__dropdown node-selector__dropdown--portal"
            elevation="high"
            padding={false}
            style={{
              position: 'absolute',
              top: `${multiMenuPos.top}px`,
              left: `${multiMenuPos.left}px`,
              width: '280px',
              maxHeight: `${multiMenuPos.maxHeight}px`,
            }}
          >
            <SearchField
              ref={searchInputRef}
              icon={<AddIcon size="sm" />}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={effectiveCreateNew ? 'Search or create...' : searchPlaceholder}
              className="node-selector__search-field"
            />
            <div className="node-selector__list">
              {isLoading && searchQuery.length > 0 ? (
                <div className="node-selector__loading">Searching...</div>
              ) : multiDropdownItems.length === 0 && !showCreateOption ? (
                <div className="node-selector__empty">
                  {searchQuery ? 'No matches found' : 'Start typing to search'}
                </div>
              ) : (
                <>
                  {multiDropdownItems.map((node, index) => {
                    const isAssigned = assignedIds.has(node.id);
                    return (
                      <NodeResultItem
                        key={node.id}
                        node={node}
                        parentPath={node.is_page ? buildParentPath(node) : ''}
                        displayClasses={node.is_page ? getDisplayClasses(node) : []}
                        isHighlighted={index === selectedIndex}
                        onClick={() => handleToggle(node)}
                        onMouseEnter={() => setSelectedIndex(index)}
                        allClasses={allClasses}
                        after={
                          <Checkbox
                            size="sm"
                            checked={isAssigned}
                            onChange={() => handleToggle(node)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      />
                    );
                  })}
                  {showCreateOption && (
                    <NodeResultItem
                      key="__create"
                      node={{ name: `Create "${searchQuery.trim()}"` } as Node}
                      isHighlighted={selectedIndex === multiDropdownItems.length}
                      onClick={handleCreateNew}
                      onMouseEnter={() => setSelectedIndex(multiDropdownItems.length)}
                      className="node-result-item--create"
                      iconOverride={<AddIcon size="sm" />}
                    />
                  )}
                </>
              )}
            </div>
            {classFilters && classFilters.length > 0 && (
              <div className="node-selector__footer">
                <span className="node-selector__hint">
                  Filtered by {classFilters.length} class{classFilters.length > 1 ? 'es' : ''}
                </span>
              </div>
            )}
          </Card>,
          document.body
        )}

        {/* Dropdown Menu for single-select - Rendered in Portal */}
        {!multi && isPickerOpen && menuPosition && createPortal(
          <Card
            ref={menuRef}
            className="node-selector__dropdown node-selector__dropdown--portal"
            elevation="high"
            padding={false}
            style={{
              position: 'absolute',
              top: `${menuPosition.top}px`,
              left: `${menuPosition.left}px`,
              minWidth: `${menuPosition.width}px`,
              maxHeight: `${menuPosition.maxHeight}px`,
            }}
          >
            {/* Search Input */}
            <div className="node-selector__search-wrapper">
              <input
                ref={searchInputRef}
                type="text"
                className="node-selector__search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
              />
            </div>
            
            {/* Results List */}
            <div className="node-selector__list">
              {isLoading && searchQuery.length > 0 ? (
                <div className="node-selector__loading">Searching...</div>
              ) : filteredResults.length === 0 && convertCandidates.length === 0 && !showCreateOption ? (
                <div className="node-selector__empty">
                  {searchQuery ? 'No matches found' : 'Start typing to search'}
                </div>
              ) : (
                <>
                  {filteredResults.map((node, index) => (
                    <NodeResultItem
                      key={node.id}
                      node={node}
                      parentPath={node.is_page ? buildParentPath(node) : ''}
                      displayClasses={node.is_page ? getDisplayClasses(node) : []}
                      isHighlighted={index === selectedIndex}
                      isSelected={assignedIds.has(node.id)}
                      onClick={() => handleAdd(node)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      allClasses={allClasses}
                    />
                  ))}

                  {convertCandidates.length > 0 && (
                    <>
                      <div className="node-selector__section-label">Convert to class</div>
                      {convertCandidates.map((node, index) => {
                        const idx = filteredResults.length + index;
                        return (
                          <NodeResultItem
                            key={`convert-${node.id}`}
                            node={node}
                            parentPath={buildParentPath(node)}
                            displayClasses={getDisplayClasses(node)}
                            isHighlighted={idx === selectedIndex}
                            onClick={() => { onConvertToClass!(node); setIsPickerOpen(false); setSearchQuery(''); }}
                            onMouseEnter={() => setSelectedIndex(idx)}
                            allClasses={allClasses}
                            className="node-result-item--convert"
                          />
                        );
                      })}
                    </>
                  )}

                  {showCreateOption && (
                    <NodeResultItem
                      key="__create"
                      node={{ name: `Create "${searchQuery.trim()}"` } as Node}
                      isHighlighted={selectedIndex === filteredResults.length + convertCandidates.length}
                      onClick={handleCreateNew}
                      onMouseEnter={() => setSelectedIndex(filteredResults.length + convertCandidates.length)}
                      className="node-result-item--create"
                      iconOverride={<AddIcon size="sm" />}
                    />
                  )}
                </>
              )}
            </div>
            
            {/* Footer with hint */}
            {classFilters && classFilters.length > 0 && (
              <div className="node-selector__footer">
                <span className="node-selector__hint">
                  Filtered by {classFilters.length} class{classFilters.length > 1 ? 'es' : ''}
                </span>
              </div>
            )}
          </Card>,
          document.body
        )}
      </div>
    );
  }

  // 'inline' mode: always-expanded search + results (used for embedded pickers)
  if (trigger === 'inline') {
    return (
      <div className={`node-selector node-selector--inline ${className}`}>
        <input
          ref={searchInputRef}
          type="text"
          className="node-selector__search"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <div className="node-selector__options">
          {isLoading && searchQuery.length > 0 ? (
            <div className="node-selector__loading">Searching...</div>
          ) : filteredResults.length === 0 && convertCandidates.length === 0 && !showCreateOption ? (
            <div className="node-selector__no-results">
              {searchQuery ? 'No matches found' : 'Start typing to search'}
            </div>
          ) : (
            <>
              {filteredResults.map((node, index) => (
                <NodeResultItem
                  key={node.id}
                  node={node}
                  parentPath={node.is_page ? buildParentPath(node) : ''}
                  displayClasses={node.is_page ? getDisplayClasses(node) : []}
                  isHighlighted={index === selectedIndex}
                  onClick={() => handleAdd(node)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  allClasses={allClasses}
                />
              ))}
              {convertCandidates.length > 0 && (
                <>
                  <div className="node-selector__section-label">Convert to class</div>
                  {convertCandidates.map((node, index) => {
                    const idx = filteredResults.length + index;
                    return (
                      <NodeResultItem
                        key={`convert-${node.id}`}
                        node={node}
                        parentPath={buildParentPath(node)}
                        displayClasses={getDisplayClasses(node)}
                        isHighlighted={idx === selectedIndex}
                        onClick={() => { onConvertToClass!(node); setIsPickerOpen(false); setSearchQuery(''); }}
                        onMouseEnter={() => setSelectedIndex(idx)}
                        allClasses={allClasses}
                        className="node-result-item--convert"
                      />
                    );
                  })}
                </>
              )}
              {showCreateOption && effectiveCreateNew && (
                <NodeResultItem
                  key="__create"
                  node={{ name: `Create "${searchQuery.trim()}"` } as Node}
                  isHighlighted={selectedIndex === filteredResults.length + convertCandidates.length}
                  onClick={handleCreateNew}
                  onMouseEnter={() => setSelectedIndex(filteredResults.length + convertCandidates.length)}
                  className="node-result-item--create"
                  iconOverride={<AddIcon size="sm" />}
                />
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // 'pill-row' mode: original behavior
  const showAddButton = !!onAdd;

  return (
    <div className={`node-selector ${className}`}>
      {nodes.map((node) => {
        const isRemovable = onRemove && (!canRemove || canRemove(node));
        return (
          <NodeRef
            key={node.id}
            node={node}
            onClick={() => onNodeClick?.(node)}
            onRemove={isRemovable ? () => onRemove(node) : undefined}
            onColorChange={onColorChange ? (color) => onColorChange(node, color) : undefined}
            readOnly={readOnly}
          />
        );
      })}
      
      {showAddButton && (
        <div className="node-selector__add-wrapper" ref={buttonRef}>
          <Button
            variant="ghost"
            size="xs"
            icon={mdiPlus}
            className="node-selector__add-btn"
            onClick={() => setIsPickerOpen(true)}
            onKeyDown={(e) => {
              // Prevent space/enter from closing the picker when it's already open.
              // Without this, the button retains focus briefly after opening and a
              // space keypress would toggle it closed before focus moves to the input.
              if (isPickerOpen && (e.key === ' ' || e.key === 'Enter')) {
                e.preventDefault();
              }
            }}
            title={emptyText}
          >
            {nodes.length === 0 ? emptyText : ''}
          </Button>
          
          {isPickerOpen && pickerPos && (
            <div
              className="node-selector__picker"
              ref={pickerRef}
              style={{ top: pickerPos.top, left: pickerPos.left }}
            >
              <input
                ref={searchInputRef}
                type="text"
                className="node-selector__search"
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <div className="node-selector__options">
                {isLoading && searchQuery.length > 0 ? (
                  <div className="node-selector__loading">Searching...</div>
                ) : filteredResults.length === 0 && convertCandidates.length === 0 && !showCreateOption ? (
                  <div className="node-selector__no-results">
                    {searchQuery ? 'No matches found' : 'Start typing to search'}
                  </div>
                ) : (
                  <>
                    {filteredResults.map((node, index) => (
                      <NodeResultItem
                        key={node.id}
                        node={node}
                        parentPath={node.is_page ? buildParentPath(node) : ''}
                        displayClasses={node.is_page ? getDisplayClasses(node) : []}
                        isHighlighted={index === selectedIndex}
                        onClick={() => handleAdd(node)}
                        onMouseEnter={() => setSelectedIndex(index)}
                        allClasses={allClasses}
                      />
                    ))}
                    {convertCandidates.length > 0 && (
                      <>
                        <div className="node-selector__section-label">Convert to class</div>
                        {convertCandidates.map((node, index) => {
                          const idx = filteredResults.length + index;
                          return (
                            <NodeResultItem
                              key={`convert-${node.id}`}
                              node={node}
                              parentPath={buildParentPath(node)}
                              displayClasses={getDisplayClasses(node)}
                              isHighlighted={idx === selectedIndex}
                              onClick={() => { onConvertToClass!(node); setIsPickerOpen(false); setSearchQuery(''); }}
                              onMouseEnter={() => setSelectedIndex(idx)}
                              allClasses={allClasses}
                              className="node-result-item--convert"
                            />
                          );
                        })}
                      </>
                    )}
                    {showCreateOption && (
                      <NodeResultItem
                        key="__create"
                        node={{ name: `Create "${searchQuery.trim()}"` } as Node}
                        isHighlighted={selectedIndex === filteredResults.length + convertCandidates.length}
                        onClick={handleCreateNew}
                        onMouseEnter={() => setSelectedIndex(filteredResults.length + convertCandidates.length)}
                        className="node-result-item--create"
                        iconOverride={<AddIcon size="xs" />}
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NodeSelector;

