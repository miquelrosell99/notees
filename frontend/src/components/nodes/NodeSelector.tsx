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
import { Spinner } from '@/components/core/Spinner';
import { createPortal } from 'react-dom';
import { useQueries } from '@tanstack/react-query';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { NodeRef } from './NodeRef';
import { Icon, AddIcon, NodeIcon } from '@/components/core/icons';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { Checkbox } from '@/components/core/Checkbox';
import { SearchField } from '@/components/core/SearchField';
import { NodeResultItem } from './NodeResultItem';
import { Button } from '@/components/core/Button';
import { Card } from '@/components/core/Card';
import { SelectTrigger, type SelectTriggerSize } from '@/components/core/SelectTrigger';

import { useNodeSearch, usePages, useClasses, useCreateNode, usePageClass, useClassClass, type NodeSearchMode, nodeKeys } from '@/hooks';
import { parseQueryWithFilters, type AppliedFilter, type FilterPrefixConfig } from '@/utils/searchFilters';
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
  /**
   * When provided, renders the picker panel as a portal anchored to this element
   * (no trigger is rendered — the panel is always open and positioned below the element).
   * Use with `onClose` to handle dismissal.
   */
  anchorEl?: HTMLElement | null;
  /** Called when the anchored panel should close (Escape / click-outside) */
  onClose?: () => void;
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
  anchorEl,
  onClose,
}: NodeSelectorProps) {
  const isAnchored = anchorEl != null;
  const [isPickerOpen, setIsPickerOpen] = useState(isAnchored);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilter[]>([]);
  const [displayLimit, setDisplayLimit] = useState(trigger === 'select' ? 15 : 10);
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

  // For parent hierarchy display on page items
  const { data: allPages = [] } = usePages();
  const { data: allClasses = [] } = useClasses();

  // Parse query for filter prefix syntax
  const parsedFilters = useMemo(
    () => parseQueryWithFilters(searchQuery, appliedFilters),
    [searchQuery, appliedFilters]
  );

  // Derive class filters from applied class filters + prop classFilters
  const derivedClassFilters = useMemo(() => {
    const appliedClassIds = appliedFilters
      .filter((f): f is AppliedFilter & { type: 'class' } => f.type === 'class')
      .map(f => f.classNode.id);
    return [...(classFilters ?? []), ...appliedClassIds];
  }, [appliedFilters, classFilters]);

  // Derive boolean filters from applied boolean filters
  const derivedBooleanFilters = useMemo(() => {
    const filters: { isPage?: boolean; isClass?: boolean; isDaily?: boolean } = {};
    for (const f of appliedFilters) {
      if (f.type === 'boolean') {
        if (f.prefix === 'is_page') filters.isPage = f.value;
        else if (f.prefix === 'is_class') filters.isClass = f.value;
        else if (f.prefix === 'is_daily') filters.isDaily = f.value;
      }
    }
    return filters;
  }, [appliedFilters]);

  // Build filter suggestion items when user is typing a filter
  type FilterSuggestionItem =
    | { type: 'class'; node: Node }
    | { type: 'boolean'; prefix: string; label: string; value: boolean }
    | { type: 'prefix'; config: FilterPrefixConfig };

  const filterSuggestions = useMemo<FilterSuggestionItem[]>(() => {
    if (parsedFilters.suggestedPrefixes.length > 0) {
      return parsedFilters.suggestedPrefixes.map(config => ({ type: 'prefix' as const, config }));
    }
    if (!parsedFilters.isTypingFilter || !parsedFilters.activeFilter) return [];

    const { activeFilter } = parsedFilters;
    if (activeFilter.config.type === 'class') {
      const query = activeFilter.value.toLowerCase();
      return (allClasses ?? [])
        .filter(c => nodeNameToText(c.name).toLowerCase().includes(query))
        .slice(0, 5)
        .map(node => ({ type: 'class' as const, node }));
    }

    if (activeFilter.config.type === 'boolean') {
      const options = activeFilter.config.options ?? [];
      const value = activeFilter.value.toLowerCase();
      return options
        .filter(opt => opt.startsWith(value))
        .map(opt => ({
          type: 'boolean' as const,
          prefix: activeFilter.prefix,
          label: activeFilter.config.label,
          value: opt === 'true',
        }));
    }

    return [];
  }, [parsedFilters, allClasses]);

  // Track pinned node ID for single-value pickers:
  // - Current value if set
  // - Last non-null value if cleared during the same picker session
  const currentSingleValue = !multi && typeof value === 'number' ? value : null;
  const [lastNonNullValue, setLastNonNullValue] = useState<number | null>(currentSingleValue);
  useEffect(() => {
    if (currentSingleValue !== null) {
      setLastNonNullValue(currentSingleValue);
    }
  }, [currentSingleValue]);
  const pinnedNodeId = !multi ? (currentSingleValue ?? lastNonNullValue) : null;

  // Use shared search hook (same as SuggestionPopup)
  const { allResults, isLoading, showCreateOption: searchShowCreate, hasMore } = useNodeSearch(
    parsedFilters.searchTerm,
    {
      mode: searchMode,
      classFilters: derivedClassFilters,
      excludeNodeId,
      maxResults: displayLimit,
      pinnedNodeId: pinnedNodeId ?? undefined,
      uuid: parsedFilters.uuidSearch ?? undefined,
      ...derivedBooleanFilters,
    }
  );

  // Secondary search for page conversion candidates (always called to respect hooks rules;
  // results only used when onConvertToClass is provided and there's an active query)
  const { allResults: pageConvertResults } = useNodeSearch(parsedFilters.searchTerm, {
    mode: 'pages',
    maxResults: 5,
    excludeNodeId,
  });

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
  const showCreateOption = effectiveCreateNew && searchShowCreate && searchQuery.trim().length > 0 && filterSuggestions.length === 0;

  // Non-class pages matching the search query, offered as "convert to class" candidates
  const convertCandidates = useMemo(() => {
    if (!onConvertToClass || !parsedFilters.searchTerm.trim()) return [];
    return pageConvertResults
      .map(r => r.node)
      .filter(n => !n.is_class && !assignedIds.has(n.id));
  }, [onConvertToClass, parsedFilters.searchTerm, pageConvertResults, assignedIds]);

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

  // Total selectable items (include "show more" row when results are truncated)
  const showMoreOption = hasMore && !multi && filterSuggestions.length === 0;
  const totalItems = multi
    ? filterSuggestions.length + multiDropdownItems.length + (showCreateOption ? 1 : 0)
    : filterSuggestions.length + filteredResults.length + convertCandidates.length + (showCreateOption ? 1 : 0) + (showMoreOption ? 1 : 0);

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
    if (isAnchored && anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      const left = Math.min(rect.left, window.innerWidth - 280 - 8);
      setPickerPos({ top: rect.bottom + 4, left });
    } else if (trigger === 'pill-row' && isPickerOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPickerPos({ top: rect.bottom + 4, left: rect.left });
    } else if (!isPickerOpen) {
      setPickerPos(null);
    }
  }, [isPickerOpen, trigger, isAnchored, anchorEl]);

  // Close picker when clicking outside
  useEffect(() => {
    if (!isPickerOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const pickerElement = trigger === 'select' ? menuRef.current : pickerRef.current;
      const triggerElement = trigger === 'select' ? containerRef.current : buttonRef.current;
      
      if (isAnchored) {
        if (pickerElement && !pickerElement.contains(target) && !anchorEl?.contains(target)) {
          onClose?.();
        }
        return;
      }
      
      if (
        pickerElement && !pickerElement.contains(target) &&
        triggerElement && !triggerElement.contains(target)
      ) {
        setIsPickerOpen(false);
        setSearchQuery('');
        setAppliedFilters([]);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isAnchored) {
          onClose?.();
        } else {
          setIsPickerOpen(false);
          setSearchQuery('');
          setAppliedFilters([]);
        }
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isPickerOpen, trigger, isAnchored, onClose, anchorEl]);

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
      setAppliedFilters([]);
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
    setAppliedFilters([]);
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

  // Show more results handler
  const handleShowMore = useCallback(() => {
    setDisplayLimit(prev => prev + 20);
  }, []);

  // Reset display limit when search query changes  
  const handleSearchChange = useCallback((newQuery: string) => {
    setSearchQuery(newQuery);
    setDisplayLimit(trigger === 'select' ? 15 : 10);
  }, [trigger]);

  // Filter suggestion handlers
  const handleAddClassFilter = useCallback((classNode: Node) => {
    setAppliedFilters(prev => {
      if (prev.some(f => f.type === 'class' && f.classNode.id === classNode.id)) return prev;
      return [...prev, { type: 'class' as const, classNode }];
    });
    setSearchQuery(prev => prev.replace(/\S+:\S*$/, '').trim());
  }, []);

  const handleAddBooleanFilter = useCallback((prefix: string, label: string, value: boolean) => {
    setAppliedFilters(prev => {
      const existing = prev.findIndex(f => f.type === 'boolean' && f.prefix === prefix);
      const newFilter = { type: 'boolean' as const, prefix, label, value };
      if (existing >= 0) {
        return prev.map((f, i) => i === existing ? newFilter : f);
      }
      return [...prev, newFilter];
    });
    setSearchQuery(prev => prev.replace(/\S+:\S*$/, '').trim());
  }, []);

  const handlePrefixSelect = useCallback((prefix: string) => {
    setSearchQuery(prev => prev.replace(/\S+$/, '') + prefix + ':');
  }, []);

  const handleRemoveFilter = useCallback((index: number) => {
    setAppliedFilters(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Keyboard list navigation
  const handleSelectByIndex = useCallback((index: number) => {
    if (index < filterSuggestions.length) {
      const item = filterSuggestions[index];
      if (item.type === 'class') {
        handleAddClassFilter(item.node);
      } else if (item.type === 'boolean') {
        handleAddBooleanFilter(item.prefix, item.label, item.value);
      } else if (item.type === 'prefix') {
        handlePrefixSelect(item.config.prefix);
      }
      return;
    }

    const adjustedIndex = index - filterSuggestions.length;

    if (multi) {
      if (adjustedIndex < multiDropdownItems.length) {
        handleToggle(multiDropdownItems[adjustedIndex]);
      } else if (showCreateOption) {
        handleCreateNew();
      }
    } else {
      if (adjustedIndex < filteredResults.length) {
        handleAdd(filteredResults[adjustedIndex]);
      } else if (adjustedIndex < filteredResults.length + convertCandidates.length) {
        const convertNode = convertCandidates[adjustedIndex - filteredResults.length];
        onConvertToClass?.(convertNode);
        setIsPickerOpen(false);
        setSearchQuery('');
        setAppliedFilters([]);
      } else if (showMoreOption && adjustedIndex === filteredResults.length + convertCandidates.length + (showCreateOption ? 1 : 0)) {
        handleShowMore();
      } else if (showCreateOption) {
        handleCreateNew();
      }
    }
  }, [filterSuggestions, multi, multiDropdownItems, filteredResults, convertCandidates, showCreateOption, showMoreOption, handleAdd, handleToggle, handleCreateNew, handleShowMore, onConvertToClass, handleAddClassFilter, handleAddBooleanFilter, handlePrefixSelect]);

  const handleClosePicker = useCallback(() => {
    if (isAnchored) {
      onClose?.();
    } else {
      setIsPickerOpen(false);
      setSearchQuery('');
      setAppliedFilters([]);
    }
  }, [isAnchored, onClose]);

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

  // Build breadcrumb path for a block node using its page_id
  const buildBlockParentPath = useCallback((node: Node): string => {
    if (!node.page_id) return '';
    const page = allPages.find(p => p.id === node.page_id);
    if (!page) return '';
    const pageName = nodeNameToText(page.name) || 'Untitled';
    const ancestors = buildParentPath(page);
    // buildParentPath returns "Parent /" format; strip trailing " /" to combine cleanly
    const trimmed = ancestors.replace(/ \/$/, '');
    return trimmed ? `${trimmed} / ${pageName}` : pageName;
  }, [allPages, buildParentPath]);

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
                <Icon path={"mdi mdi-chevron-down"} size={0.7} />
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
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={effectiveCreateNew ? 'Search or create...' : searchPlaceholder}
              className="node-selector__search-field"
            />
            {appliedFilters.length > 0 && (
              <div className="node-selector__filter-pills">
                {appliedFilters.map((filter, fi) => (
                  <span key={`${filter.type}-${fi}`} className="node-selector__filter-pill">
                    {filter.type === 'class' ? (
                      <>
                        <span className="node-selector__filter-pill-label">class:</span>
                        <span>{nodeNameToText(filter.classNode.name)}</span>
                      </>
                    ) : (
                      <>
                        <span className="node-selector__filter-pill-label">{filter.prefix}:</span>
                        <span>{filter.value ? 'true' : 'false'}</span>
                      </>
                    )}
                    <button
                      className="node-selector__filter-pill-remove"
                      onClick={() => handleRemoveFilter(fi)}
                      aria-label="Remove filter"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="node-selector__list">
              {isLoading && searchQuery.length > 0 ? (
                <div className="node-selector__loading"><Spinner size="sm" label="Searching..." /></div>
              ) : multiDropdownItems.length === 0 && !showCreateOption && filterSuggestions.length === 0 ? (
                <div className="node-selector__empty">
                  {searchQuery ? 'No matches found' : 'Start typing to search'}
                </div>
              ) : (
                <>
                  {filterSuggestions.map((item, index) => {
                    const isHighlighted = index === selectedIndex;
                    if (item.type === 'class') {
                      return (
                        <NodeResultItem
                          key={`filter-class-${item.node.id}`}
                          node={item.node}
                          isHighlighted={isHighlighted}
                          onClick={() => handleAddClassFilter(item.node)}
                          onMouseEnter={() => setSelectedIndex(index)}
                          className="node-result-item--filter-suggestion"
                          iconOverride={<span className="node-selector__filter-prefix">class:</span>}
                        />
                      );
                    }
                    return (
                      <button
                        key={`filter-${item.type}-${item.type === 'boolean' ? item.prefix : item.config.prefix}`}
                        className={`node-selector__filter-suggestion ${isHighlighted ? 'node-selector__filter-suggestion--highlighted' : ''}`}
                        onClick={() => item.type === 'boolean'
                          ? handleAddBooleanFilter(item.prefix, item.label, item.value)
                          : handlePrefixSelect(item.config.prefix)
                        }
                        onMouseEnter={() => setSelectedIndex(index)}
                      >
                        <span className="node-selector__filter-prefix">
                          {item.type === 'boolean' ? `${item.prefix}:` : item.config.label}
                        </span>
                        <span className="node-selector__filter-value">
                          {item.type === 'boolean' ? (item.value ? 'true' : 'false') : item.config.description}
                        </span>
                      </button>
                    );
                  })}
                  {multiDropdownItems.map((node, index) => {
                    const isAssigned = assignedIds.has(node.id);
                    const globalIndex = filterSuggestions.length + index;
                    return (
                      <NodeResultItem
                        key={node.id}
                        node={node}
                        parentPath={node.is_page ? buildParentPath(node) : buildBlockParentPath(node)}
                        displayClasses={getDisplayClasses(node)}
                        isHighlighted={globalIndex === selectedIndex}
                        onClick={() => handleToggle(node)}
                        onMouseEnter={() => setSelectedIndex(globalIndex)}
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
                      isHighlighted={selectedIndex === filterSuggestions.length + multiDropdownItems.length}
                      onClick={handleCreateNew}
                      onMouseEnter={() => setSelectedIndex(filterSuggestions.length + multiDropdownItems.length)}
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
                onChange={(e) => handleSearchChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
              />
            </div>
            
            {/* Filter pills */}
            {appliedFilters.length > 0 && (
              <div className="node-selector__filter-pills">
                {appliedFilters.map((filter, fi) => (
                  <span key={`${filter.type}-${fi}`} className="node-selector__filter-pill">
                    {filter.type === 'class' ? (
                      <>
                        <span className="node-selector__filter-pill-label">class:</span>
                        <span>{nodeNameToText(filter.classNode.name)}</span>
                      </>
                    ) : (
                      <>
                        <span className="node-selector__filter-pill-label">{filter.prefix}:</span>
                        <span>{filter.value ? 'true' : 'false'}</span>
                      </>
                    )}
                    <button
                      className="node-selector__filter-pill-remove"
                      onClick={() => handleRemoveFilter(fi)}
                      aria-label="Remove filter"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            
            {/* Results List */}
            <div className="node-selector__list">
              {isLoading && searchQuery.length > 0 ? (
                <div className="node-selector__loading"><Spinner size="sm" label="Searching..." /></div>
              ) : filteredResults.length === 0 && convertCandidates.length === 0 && !showCreateOption && filterSuggestions.length === 0 ? (
                <div className="node-selector__empty">
                  {searchQuery ? 'No matches found' : 'Start typing to search'}
                </div>
              ) : (
                <>
                  {filterSuggestions.map((item, index) => {
                    const isHighlighted = index === selectedIndex;
                    if (item.type === 'class') {
                      return (
                        <NodeResultItem
                          key={`filter-class-${item.node.id}`}
                          node={item.node}
                          isHighlighted={isHighlighted}
                          onClick={() => handleAddClassFilter(item.node)}
                          onMouseEnter={() => setSelectedIndex(index)}
                          className="node-result-item--filter-suggestion"
                          iconOverride={<span className="node-selector__filter-prefix">class:</span>}
                        />
                      );
                    }
                    return (
                      <button
                        key={`filter-${item.type}-${item.type === 'boolean' ? item.prefix : item.config.prefix}`}
                        className={`node-selector__filter-suggestion ${isHighlighted ? 'node-selector__filter-suggestion--highlighted' : ''}`}
                        onClick={() => item.type === 'boolean'
                          ? handleAddBooleanFilter(item.prefix, item.label, item.value)
                          : handlePrefixSelect(item.config.prefix)
                        }
                        onMouseEnter={() => setSelectedIndex(index)}
                      >
                        <span className="node-selector__filter-prefix">
                          {item.type === 'boolean' ? `${item.prefix}:` : item.config.label}
                        </span>
                        <span className="node-selector__filter-value">
                          {item.type === 'boolean' ? (item.value ? 'true' : 'false') : item.config.description}
                        </span>
                      </button>
                    );
                  })}
                  {filteredResults.map((node, index) => {
                    const globalIndex = filterSuggestions.length + index;
                    return (
                      <NodeResultItem
                        key={node.id}
                        node={node}
                        parentPath={node.is_page ? buildParentPath(node) : buildBlockParentPath(node)}
                        displayClasses={getDisplayClasses(node)}
                        isHighlighted={globalIndex === selectedIndex}
                        isSelected={assignedIds.has(node.id)}
                        onClick={() => handleAdd(node)}
                        onMouseEnter={() => setSelectedIndex(globalIndex)}
                        allClasses={allClasses}
                      />
                    );
                  })}

                  {convertCandidates.length > 0 && (
                    <>
                      <div className="node-selector__section-label">Convert to class</div>
                      {convertCandidates.map((node, index) => {
                        const idx = filterSuggestions.length + filteredResults.length + index;
                        return (
                          <NodeResultItem
                            key={`convert-${node.id}`}
                            node={node}
                            parentPath={buildParentPath(node)}
                            displayClasses={getDisplayClasses(node)}
                            isHighlighted={idx === selectedIndex}
                            onClick={() => { onConvertToClass!(node); setIsPickerOpen(false); setSearchQuery(''); setAppliedFilters([]); }}
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
                      isHighlighted={selectedIndex === filterSuggestions.length + filteredResults.length + convertCandidates.length}
                      onClick={handleCreateNew}
                      onMouseEnter={() => setSelectedIndex(filterSuggestions.length + filteredResults.length + convertCandidates.length)}
                      className="node-result-item--create"
                      iconOverride={<AddIcon size="sm" />}
                    />
                  )}
                  {showMoreOption && (
                    <button
                      className={`node-selector__show-more ${selectedIndex === filterSuggestions.length + filteredResults.length + convertCandidates.length + (showCreateOption ? 1 : 0) ? 'node-selector__show-more--highlighted' : ''}`}
                      onClick={handleShowMore}
                      onMouseEnter={() => setSelectedIndex(filterSuggestions.length + filteredResults.length + convertCandidates.length + (showCreateOption ? 1 : 0))}
                    >
                      Show more results
                    </button>
                  )}
                </>
              )}
            </div>
            
            {/* Footer with hint */}
            {(classFilters && classFilters.length > 0) || appliedFilters.length > 0 ? (
              <div className="node-selector__footer">
                <span className="node-selector__hint">
                  {appliedFilters.length > 0
                    ? `${appliedFilters.length} filter${appliedFilters.length > 1 ? 's' : ''} active`
                    : `Filtered by ${classFilters!.length} class${classFilters!.length > 1 ? 'es' : ''}`}
                </span>
              </div>
            ) : null}
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
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        {appliedFilters.length > 0 && (
          <div className="node-selector__filter-pills">
            {appliedFilters.map((filter, fi) => (
              <span key={`${filter.type}-${fi}`} className="node-selector__filter-pill">
                {filter.type === 'class' ? (
                  <>
                    <span className="node-selector__filter-pill-label">class:</span>
                    <span>{nodeNameToText(filter.classNode.name)}</span>
                  </>
                ) : (
                  <>
                    <span className="node-selector__filter-pill-label">{filter.prefix}:</span>
                    <span>{filter.value ? 'true' : 'false'}</span>
                  </>
                )}
                <button
                  className="node-selector__filter-pill-remove"
                  onClick={() => handleRemoveFilter(fi)}
                  aria-label="Remove filter"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="node-selector__options">
          {isLoading && searchQuery.length > 0 ? (
            <div className="node-selector__loading"><Spinner size="sm" label="Searching..." /></div>
          ) : filteredResults.length === 0 && convertCandidates.length === 0 && !showCreateOption && filterSuggestions.length === 0 ? (
            <div className="node-selector__no-results">
              {searchQuery ? 'No matches found' : 'Start typing to search'}
            </div>
          ) : (
            <>
              {filterSuggestions.map((item, index) => {
                const isHighlighted = index === selectedIndex;
                if (item.type === 'class') {
                  return (
                    <NodeResultItem
                      key={`filter-class-${item.node.id}`}
                      node={item.node}
                      isHighlighted={isHighlighted}
                      onClick={() => handleAddClassFilter(item.node)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className="node-result-item--filter-suggestion"
                      iconOverride={<span className="node-selector__filter-prefix">class:</span>}
                    />
                  );
                }
                return (
                  <button
                    key={`filter-${item.type}-${item.type === 'boolean' ? item.prefix : item.config.prefix}`}
                    className={`node-selector__filter-suggestion ${isHighlighted ? 'node-selector__filter-suggestion--highlighted' : ''}`}
                    onClick={() => item.type === 'boolean'
                      ? handleAddBooleanFilter(item.prefix, item.label, item.value)
                      : handlePrefixSelect(item.config.prefix)
                    }
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span className="node-selector__filter-prefix">
                      {item.type === 'boolean' ? `${item.prefix}:` : item.config.label}
                    </span>
                    <span className="node-selector__filter-value">
                      {item.type === 'boolean' ? (item.value ? 'true' : 'false') : item.config.description}
                    </span>
                  </button>
                );
              })}
              {filteredResults.map((node, index) => {
                const globalIndex = filterSuggestions.length + index;
                return (
                  <NodeResultItem
                    key={node.id}
                    node={node}
                    parentPath={node.is_page ? buildParentPath(node) : buildBlockParentPath(node)}
                    displayClasses={getDisplayClasses(node)}
                    isHighlighted={globalIndex === selectedIndex}
                    onClick={() => handleAdd(node)}
                    onMouseEnter={() => setSelectedIndex(globalIndex)}
                    allClasses={allClasses}
                  />
                );
              })}
              {convertCandidates.length > 0 && (
                <>
                  <div className="node-selector__section-label">Convert to class</div>
                  {convertCandidates.map((node, index) => {
                    const idx = filterSuggestions.length + filteredResults.length + index;
                    return (
                      <NodeResultItem
                        key={`convert-${node.id}`}
                        node={node}
                        parentPath={buildParentPath(node)}
                        displayClasses={getDisplayClasses(node)}
                        isHighlighted={idx === selectedIndex}
                        onClick={() => { onConvertToClass!(node); setIsPickerOpen(false); setSearchQuery(''); setAppliedFilters([]); }}
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
                  isHighlighted={selectedIndex === filterSuggestions.length + filteredResults.length + convertCandidates.length}
                  onClick={handleCreateNew}
                  onMouseEnter={() => setSelectedIndex(filterSuggestions.length + filteredResults.length + convertCandidates.length)}
                  className="node-result-item--create"
                  iconOverride={<AddIcon size="sm" />}
                />
              )}
              {showMoreOption && (
                <button
                  className={`node-selector__show-more ${selectedIndex === filterSuggestions.length + filteredResults.length + convertCandidates.length + (showCreateOption ? 1 : 0) ? 'node-selector__show-more--highlighted' : ''}`}
                  onClick={handleShowMore}
                  onMouseEnter={() => setSelectedIndex(filterSuggestions.length + filteredResults.length + convertCandidates.length + (showCreateOption ? 1 : 0))}
                >
                  Show more results
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // 'pill-row' mode: original behavior
  const showAddButton = !!onAdd;

  // Anchored mode: render only the picker panel portal, no trigger UI
  if (isAnchored) {
    return pickerPos ? createPortal(
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
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        {appliedFilters.length > 0 && (
          <div className="node-selector__filter-pills">
            {appliedFilters.map((filter, fi) => (
              <span key={`${filter.type}-${fi}`} className="node-selector__filter-pill">
                {filter.type === 'class' ? (
                  <>
                    <span className="node-selector__filter-pill-label">class:</span>
                    <span>{nodeNameToText(filter.classNode.name)}</span>
                  </>
                ) : (
                  <>
                    <span className="node-selector__filter-pill-label">{filter.prefix}:</span>
                    <span>{filter.value ? 'true' : 'false'}</span>
                  </>
                )}
                <button
                  className="node-selector__filter-pill-remove"
                  onClick={() => handleRemoveFilter(fi)}
                  aria-label="Remove filter"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="node-selector__options">
          {isLoading && searchQuery.length > 0 ? (
            <div className="node-selector__loading"><Spinner size="sm" label="Searching..." /></div>
          ) : filteredResults.length === 0 && !showCreateOption && filterSuggestions.length === 0 ? (
            <div className="node-selector__no-results">
              {searchQuery ? 'No matches found' : 'Start typing to search'}
            </div>
          ) : (
            <>
              {filterSuggestions.map((item, index) => {
                const isHighlighted = index === selectedIndex;
                if (item.type === 'class') {
                  return (
                    <NodeResultItem
                      key={`filter-class-${item.node.id}`}
                      node={item.node}
                      isHighlighted={isHighlighted}
                      onClick={() => handleAddClassFilter(item.node)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className="node-result-item--filter-suggestion"
                      iconOverride={<span className="node-selector__filter-prefix">class:</span>}
                    />
                  );
                }
                return (
                  <button
                    key={`filter-${item.type}-${item.type === 'boolean' ? item.prefix : item.config.prefix}`}
                    className={`node-selector__filter-suggestion ${isHighlighted ? 'node-selector__filter-suggestion--highlighted' : ''}`}
                    onClick={() => item.type === 'boolean'
                      ? handleAddBooleanFilter(item.prefix, item.label, item.value)
                      : handlePrefixSelect(item.config.prefix)
                    }
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span className="node-selector__filter-prefix">
                      {item.type === 'boolean' ? `${item.prefix}:` : item.config.label}
                    </span>
                    <span className="node-selector__filter-value">
                      {item.type === 'boolean' ? (item.value ? 'true' : 'false') : item.config.description}
                    </span>
                  </button>
                );
              })}
              {filteredResults.map((node, index) => {
                const globalIndex = filterSuggestions.length + index;
                return (
                  <NodeResultItem
                    key={node.id}
                    node={node}
                    parentPath={node.is_page ? buildParentPath(node) : buildBlockParentPath(node)}
                    displayClasses={getDisplayClasses(node)}
                    isHighlighted={globalIndex === selectedIndex}
                    onClick={() => handleAdd(node)}
                    onMouseEnter={() => setSelectedIndex(globalIndex)}
                    allClasses={allClasses}
                  />
                );
              })}
              {showCreateOption && (
                <NodeResultItem
                  key="__create"
                  node={{ name: `Create "${searchQuery.trim()}"` } as Node}
                  isHighlighted={selectedIndex === filterSuggestions.length + filteredResults.length}
                  onClick={handleCreateNew}
                  onMouseEnter={() => setSelectedIndex(filterSuggestions.length + filteredResults.length)}
                  className="node-result-item--create"
                  iconOverride={<AddIcon size="sm" />}
                />
              )}
              {showMoreOption && (
                <button
                  className={`node-selector__show-more ${selectedIndex === filterSuggestions.length + filteredResults.length + (showCreateOption ? 1 : 0) ? 'node-selector__show-more--highlighted' : ''}`}
                  onClick={handleShowMore}
                  onMouseEnter={() => setSelectedIndex(filterSuggestions.length + filteredResults.length + (showCreateOption ? 1 : 0))}
                >
                  Show more results
                </button>
              )}
            </>
          )}
        </div>
      </div>,
      document.body,
    ) : null;
  }

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
            icon={"mdi mdi-plus"}
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
                onChange={(e) => handleSearchChange(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              {appliedFilters.length > 0 && (
                <div className="node-selector__filter-pills">
                  {appliedFilters.map((filter, fi) => (
                    <span key={`${filter.type}-${fi}`} className="node-selector__filter-pill">
                      {filter.type === 'class' ? (
                        <>
                          <span className="node-selector__filter-pill-label">class:</span>
                          <span>{nodeNameToText(filter.classNode.name)}</span>
                        </>
                      ) : (
                        <>
                          <span className="node-selector__filter-pill-label">{filter.prefix}:</span>
                          <span>{filter.value ? 'true' : 'false'}</span>
                        </>
                      )}
                      <button
                        className="node-selector__filter-pill-remove"
                        onClick={() => handleRemoveFilter(fi)}
                        aria-label="Remove filter"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="node-selector__options">
                {isLoading && searchQuery.length > 0 ? (
                  <div className="node-selector__loading"><Spinner size="sm" label="Searching..." /></div>
                ) : filteredResults.length === 0 && convertCandidates.length === 0 && !showCreateOption && filterSuggestions.length === 0 ? (
                  <div className="node-selector__no-results">
                    {searchQuery ? 'No matches found' : 'Start typing to search'}
                  </div>
                ) : (
                  <>
                    {filterSuggestions.map((item, index) => {
                      const isHighlighted = index === selectedIndex;
                      if (item.type === 'class') {
                        return (
                          <NodeResultItem
                            key={`filter-class-${item.node.id}`}
                            node={item.node}
                            isHighlighted={isHighlighted}
                            onClick={() => handleAddClassFilter(item.node)}
                            onMouseEnter={() => setSelectedIndex(index)}
                            className="node-result-item--filter-suggestion"
                            iconOverride={<span className="node-selector__filter-prefix">class:</span>}
                          />
                        );
                      }
                      return (
                        <button
                          key={`filter-${item.type}-${item.type === 'boolean' ? item.prefix : item.config.prefix}`}
                          className={`node-selector__filter-suggestion ${isHighlighted ? 'node-selector__filter-suggestion--highlighted' : ''}`}
                          onClick={() => item.type === 'boolean'
                            ? handleAddBooleanFilter(item.prefix, item.label, item.value)
                            : handlePrefixSelect(item.config.prefix)
                          }
                          onMouseEnter={() => setSelectedIndex(index)}
                        >
                          <span className="node-selector__filter-prefix">
                            {item.type === 'boolean' ? `${item.prefix}:` : item.config.label}
                          </span>
                          <span className="node-selector__filter-value">
                            {item.type === 'boolean' ? (item.value ? 'true' : 'false') : item.config.description}
                          </span>
                        </button>
                      );
                    })}
                    {filteredResults.map((node, index) => {
                      const globalIndex = filterSuggestions.length + index;
                      return (
                        <NodeResultItem
                          key={node.id}
                          node={node}
                          parentPath={node.is_page ? buildParentPath(node) : buildBlockParentPath(node)}
                          displayClasses={getDisplayClasses(node)}
                          isHighlighted={globalIndex === selectedIndex}
                          onClick={() => handleAdd(node)}
                          onMouseEnter={() => setSelectedIndex(globalIndex)}
                          allClasses={allClasses}
                        />
                      );
                    })}
                    {convertCandidates.length > 0 && (
                      <>
                        <div className="node-selector__section-label">Convert to class</div>
                        {convertCandidates.map((node, index) => {
                          const idx = filterSuggestions.length + filteredResults.length + index;
                          return (
                            <NodeResultItem
                              key={`convert-${node.id}`}
                              node={node}
                              parentPath={buildParentPath(node)}
                              displayClasses={getDisplayClasses(node)}
                              isHighlighted={idx === selectedIndex}
                              onClick={() => { onConvertToClass!(node); setIsPickerOpen(false); setSearchQuery(''); setAppliedFilters([]); }}
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
                        isHighlighted={selectedIndex === filterSuggestions.length + filteredResults.length + convertCandidates.length}
                        onClick={handleCreateNew}
                        onMouseEnter={() => setSelectedIndex(filterSuggestions.length + filteredResults.length + convertCandidates.length)}
                        className="node-result-item--create"
                        iconOverride={<AddIcon size="xs" />}
                      />
                    )}
                    {showMoreOption && (
                      <button
                        className={`node-selector__show-more ${selectedIndex === filterSuggestions.length + filteredResults.length + convertCandidates.length + (showCreateOption ? 1 : 0) ? 'node-selector__show-more--highlighted' : ''}`}
                        onClick={handleShowMore}
                        onMouseEnter={() => setSelectedIndex(filterSuggestions.length + filteredResults.length + convertCandidates.length + (showCreateOption ? 1 : 0))}
                      >
                        Show more results
                      </button>
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

