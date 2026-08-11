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
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { autoUpdate, computePosition, flip, offset, shift, size as floatingSize } from '@floating-ui/dom';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { NodeRef } from './NodeRef';
import { Button } from '@/components/ui/Button';
import { Icon, AddIcon, NodeIcon } from '@/components/ui/icons';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { SearchField } from '@/components/ui/SearchField';
import { FilterPills } from './NodeSelectorParts/FilterPills';
import { ResultsList, type FilterSuggestionItem } from './NodeSelectorParts/ResultsList';
import { Card } from '@/components/ui/Card';
import { SelectTrigger, type SelectTriggerSize } from '@/components/ui/SelectTrigger';

import { useNodeSearch, usePages, useClasses, useCreateNode, useClassClass, type NodeSearchMode, nodeKeys } from '@/features/content';
import {
  getOrCreateDailyNoteClient,
  getOrCreateMonthlyNoteClient,
  getOrCreateYearlyNoteClient,
} from '@/features/content/hooks/useNodeDateQueries';
import { parseQueryWithFilters, type AppliedFilter } from '@/utils/searchFilters';
import { parseDate, generateDateUuid } from '@/utils/dateParser';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { projectNodeFromClient } from '@/core/adapters/nodeProjection';
import { nodeNameToText, nodeNameToDisplayText } from '@/features/queries';
import { useSettingsStore } from '@/stores';
import type { Node } from '@/types';
import './NodeSelector.css';

type TriggerMode = 'pill-row' | 'select' | 'inline';

/** Gap between trigger/anchor and the floating picker or dropdown. */
const PICKER_GAP = 4;
/** Viewport edge clearance for the pill-row / anchored picker. */
const PICKER_EDGE_PADDING = 8;
/** Viewport edge clearance for the select-mode dropdown. */
const MENU_EDGE_PADDING = 16;
/** Max height of the multi-select dropdown. */
const MULTI_MENU_MAX_HEIGHT = 320;

interface NodeSelectorProps {
  /** The nodes to display as pills (or selected values in 'select' mode) */
  nodes?: Node[];
  /** Alternative: provide node UUIDs instead of Node objects ('select' mode will fetch them) */
  value?: string | string[] | null;
  /** Search mode for the picker - determines what types of nodes to show */
  searchMode?: NodeSearchMode;
  /** Class IDs to filter search results by (nodes must have at least one of these classes) */
  classFilters?: string[];
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
  onChange?: (value: string | string[] | null) => void;
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
  /** Node UUID to exclude from search results (e.g., current node) */
  excludeNodeId?: string;
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
  /** ID for the root element, used for label association */
  id?: string;
  /** When true, the remove icon on pills is hidden until the pill is hovered or focused. */
  rightIconHoverReveal?: boolean;
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
  id,
  rightIconHoverReveal = false,
}: NodeSelectorProps) {
  const isAnchored = anchorEl != null;
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const [isPickerOpen, setIsPickerOpen] = useState(isAnchored);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilter[]>([]);
  const [displayLimit, setDisplayLimit] = useState(trigger === 'select' ? 15 : 10);
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

  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');

  // Fetch each node by ID individually - reliable regardless of pagination
  const nodeQueries = useQueries({
    queries: nodesProp ? [] : valueIds.map((nodeUuid) => ({
      queryKey: nodeKeys.detail(nodeUuid, { include_children: false }),
      queryFn: async () => (client ? await projectNodeFromClient(client, nodeUuid) : null),
      staleTime: 5 * 60 * 1000,
      enabled: !!nodeUuid && !!client,
    })),
  });

  // Resolve nodes from individual queries
  const resolvedNodesFromValue = useMemo(() => {
    return nodeQueries
      .map(query => query.data)
      .filter((n): n is Node => n !== undefined && n !== null);
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

  // Parse query for date formats and look up existing date page
  const parsedDate = useMemo(() => {
    if (searchMode !== 'pages' && searchMode !== 'all') return null;
    return parseDate(parsedFilters.searchTerm);
  }, [parsedFilters.searchTerm, searchMode]);

  const datePageUuid = useMemo(
    () => (parsedDate ? generateDateUuid(parsedDate) : null),
    [parsedDate]
  );

  // Project the deterministic date UUID directly from the worker so the
  // suggestion works even when the full page list query is slow.
  const { data: existingDateNode = null } = useQuery({
    queryKey: nodeKeys.detail(datePageUuid ?? '', { include_children: false }),
    queryFn: async (): Promise<Node | null> => {
      if (!client || !datePageUuid) return null;
      return (await client.query<Node | undefined>('projectNode', [datePageUuid])) ?? null;
    },
    enabled: !!client && !!datePageUuid,
    placeholderData: null,
  });

  // Derive class filters from applied class filters + prop classFilters
  const derivedClassFilters = useMemo(() => {
    const appliedClassIds = appliedFilters
      .filter((f): f is AppliedFilter & { type: 'class' } => f.type === 'class')
      .map(f => f.classNode.uuid);
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
  const currentSingleValue = !multi && typeof value === 'string' ? value : null;
  const [lastNonNullValue, setLastNonNullValue] = useState<string | null>(currentSingleValue);
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
      nodeUuid: parsedFilters.uuidSearch ?? undefined,
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
  const { classClassUuid } = useClassClass();

  // Resolve whether create is enabled: default true for page/class/tag modes, false for blocks
  const createEnabled = allowCreate ?? (searchMode !== 'blocks');

  // Internal default create handler based on searchMode
  const defaultCreateNew = useCallback(async (name: string): Promise<Node> => {
    const classUuids: string[] = [];
    if ((searchMode === 'classes') && classClassUuid) classUuids.push(classClassUuid);
    return new Promise((resolve, reject) => {
      createNodeMutation.mutate({ name, kind: 'page', class_uuids: classUuids.length > 0 ? classUuids : undefined }, {
        onSuccess: resolve,
        onError: reject,
      });
    });
  }, [createNodeMutation, classClassUuid, searchMode]);

  // Effective create handler: external overrides internal
  const effectiveCreateNew = onCreateNew ?? (createEnabled ? defaultCreateNew : undefined);

  // Convert search results to Node array
  const searchResults = useMemo(() => {
    return allResults.map(r => r.node);
  }, [allResults]);

  // Filter out already assigned nodes and nodes that cannot be added
  // Use raw value IDs (not resolved nodes) to ensure exclusion works even when nodes haven't loaded
  const assignedIds = useMemo(() => {
    const ids = new Set(nodes.map(n => n.uuid));
    // Also include raw value IDs to cover unresolved nodes
    for (const id of valueIds) {
      ids.add(id);
    }
    return ids;
  }, [nodes, valueIds]);

  const handleAdd = useCallback((node: Node) => {
    // Prevent adding duplicates
    if (assignedIds.has(node.uuid)) return;

    if (onChange) {
      // Value-based API: update value
      const newValue = multi
        ? [...(Array.isArray(value) ? value : []), node.uuid]
        : node.uuid;
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

  // Date suggestion handling
  const handleDateSelect = useCallback(async () => {
    if (!parsedDate || !client) return;
    try {
      let dateNode: Node;
      if (existingDateNode) {
        dateNode = existingDateNode;
      } else if (parsedDate.type === 'day' && parsedDate.month && parsedDate.day) {
        const dateStr = `${parsedDate.year}-${String(parsedDate.month).padStart(2, '0')}-${String(parsedDate.day).padStart(2, '0')}`;
        dateNode = await getOrCreateDailyNoteClient(client, dateStr);
      } else if (parsedDate.type === 'month' && parsedDate.month) {
        dateNode = await getOrCreateMonthlyNoteClient(client, parsedDate.year, parsedDate.month);
      } else {
        dateNode = await getOrCreateYearlyNoteClient(client, parsedDate.year);
      }
      handleAdd(dateNode);
    } catch (error) {
      console.error('Failed to get or create date page:', error);
    }
  }, [parsedDate, existingDateNode, client, handleAdd]);

  const dateSuggestion = useMemo(() => {
    if (!parsedDate) return undefined;
    const dateTypeLabel = parsedDate.type === 'day' ? 'daily' : parsedDate.type === 'month' ? 'monthly' : 'yearly';
    const label = existingDateNode
      ? `Go to ${dateTypeLabel} page: ${parsedDate.label}`
      : `Create ${dateTypeLabel} page: ${parsedDate.label}`;
    return { parsedDate, existingNode: existingDateNode, label, onSelect: handleDateSelect };
  }, [parsedDate, existingDateNode, handleDateSelect]);

  const filteredResults = useMemo(() => {
    return searchResults
      .filter(node => !assignedIds.has(node.uuid))
      .filter(node => !canAdd || canAdd(node));
  }, [searchResults, assignedIds, canAdd]);

  // Only show create option if a create handler is available and there's a query
  const showCreateOption = effectiveCreateNew && searchShowCreate && searchQuery.trim().length > 0 && filterSuggestions.length === 0;

  // Non-class pages matching the search query, offered as "convert to class" candidates
  const convertCandidates = useMemo(() => {
    if (!onConvertToClass || !parsedFilters.searchTerm.trim()) return [];
    return pageConvertResults
      .map(r => r.node)
      .filter(n => !n.is_class && !assignedIds.has(n.uuid));
  }, [onConvertToClass, parsedFilters.searchTerm, pageConvertResults, assignedIds]);

  // For multi-select dropdown: selected nodes first, then unselected search results
  const multiDropdownItems = useMemo(() => {
    if (!multi) return [];
    // Get all search results that can be added (without excluding assigned ones)
    const allSearchable = searchResults.filter(node => !canAdd || canAdd(node));
    const selected = allSearchable.filter(node => assignedIds.has(node.uuid));
    const unselected = allSearchable.filter(node => !assignedIds.has(node.uuid));
    // Also include assigned nodes that aren't in search results (when no search query)
    const searchIds = new Set(allSearchable.map(n => n.uuid));
    const assignedNotInSearch = nodes.filter(n => !searchIds.has(n.uuid));
    return [...assignedNotInSearch, ...selected, ...unselected];
  }, [multi, searchResults, assignedIds, canAdd, nodes]);

  // Total selectable items (include "show more" row when results are truncated)
  const showMoreOption = hasMore && !multi && filterSuggestions.length === 0;
  const dateSuggestionCount = dateSuggestion ? 1 : 0;
  const totalItems = multi
    ? dateSuggestionCount + filterSuggestions.length + multiDropdownItems.length + (showCreateOption ? 1 : 0)
    : dateSuggestionCount + filterSuggestions.length + filteredResults.length + convertCandidates.length + (showCreateOption ? 1 : 0) + (showMoreOption ? 1 : 0);

  // Position menu for 'select' single mode with viewport flip
  const menuPosition = useViewportFlip(
    containerRef,
    trigger === 'select' && !multi && isPickerOpen,
    { maxHeight: 320, includeWidth: true, minWidth: 240, popupRef: menuRef },
  );

  // Position the multi-select dropdown with Floating UI: anchored to the arrow
  // button, right-aligned ('bottom-end'), flipping above when there's no room
  // below. Position and max-height are written imperatively to the menu element
  // so scroll-driven repositioning never goes through React renders.
  useLayoutEffect(() => {
    if (!(trigger === 'select' && multi && isPickerOpen)) return;
    const reference = arrowBtnRef.current;
    const floating = menuRef.current;
    if (!reference || !floating) return;

    const update = () => {
      computePosition(reference, floating, {
        placement: 'bottom-end',
        strategy: 'absolute',
        middleware: [
          offset(PICKER_GAP),
          flip({ padding: MENU_EDGE_PADDING, fallbackPlacements: ['top-end'] }),
          floatingSize({
            padding: MENU_EDGE_PADDING,
            apply({ availableHeight }) {
              floating.style.maxHeight = `${Math.min(MULTI_MENU_MAX_HEIGHT, Math.max(0, availableHeight - PICKER_GAP))}px`;
            },
          }),
          shift({ padding: MENU_EDGE_PADDING, crossAxis: true }),
        ],
      }).then(({ x, y }) => {
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.style.visibility = 'visible';
      });
    };

    update();
    return autoUpdate(reference, floating, update);
  }, [trigger, multi, isPickerOpen]);

  // Position the pill-row / anchored picker with Floating UI. The picker is
  // position:fixed (and portaled to body in anchored mode), so the strategy is
  // 'fixed'. Hidden until the first compute, then positioned imperatively.
  useLayoutEffect(() => {
    if (!isPickerOpen) return;
    const reference = isAnchored ? anchorEl : trigger === 'pill-row' ? buttonRef.current : null;
    const floating = pickerRef.current;
    if (!reference || !floating) return;

    const update = () => {
      computePosition(reference, floating, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [
          offset(PICKER_GAP),
          flip({ padding: PICKER_EDGE_PADDING, fallbackPlacements: ['top-start'] }),
          shift({ padding: PICKER_EDGE_PADDING, crossAxis: true }),
        ],
      }).then(({ x, y }) => {
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.style.visibility = 'visible';
      });
    };

    update();
    return autoUpdate(reference, floating, update);
  }, [isPickerOpen, isAnchored, anchorEl, trigger]);

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

  // Focus search input when picker opens. The picker always renders (hidden
  // until positioned) while open, so the input ref is available on the first run.
  useEffect(() => {
    if (isPickerOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isPickerOpen, menuPosition]);

  const handleRemove = useCallback((node: Node) => {
    if (onChange) {
      // Value-based API: update value
      if (multi && Array.isArray(value)) {
        onChange(value.filter(id => id !== node.uuid));
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
    if (assignedIds.has(node.uuid)) {
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
      if (prev.some(f => f.type === 'class' && f.classNode.uuid === classNode.uuid)) return prev;
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
    if (dateSuggestion && index === 0) {
      dateSuggestion.onSelect();
      return;
    }

    const offset = dateSuggestion ? 1 : 0;
    if (index - offset < filterSuggestions.length) {
      const item = filterSuggestions[index - offset];
      if (item.type === 'class') {
        handleAddClassFilter(item.node);
      } else if (item.type === 'boolean') {
        handleAddBooleanFilter(item.prefix, item.label, item.value);
      } else if (item.type === 'prefix') {
        handlePrefixSelect(item.config.prefix);
      }
      return;
    }

    const adjustedIndex = index - offset - filterSuggestions.length;

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
  }, [dateSuggestion, filterSuggestions, multi, multiDropdownItems, filteredResults, convertCandidates, showCreateOption, showMoreOption, handleAdd, handleToggle, handleCreateNew, handleShowMore, onConvertToClass, handleAddClassFilter, handleAddBooleanFilter, handlePrefixSelect]);

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
    if (!node.parent_uuid) return '';
    const segments: string[] = [];
    let currentId: string | null = node.parent_uuid;
    while (currentId !== null) {
      const parent = allPages.find(p => p.uuid === currentId && p.is_page);
      if (!parent) break;
      segments.unshift(nodeNameToDisplayText(parent, { dateFormat }) || 'Untitled');
      currentId = parent.parent_uuid ?? null;
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
  }, [allPages, dateFormat]);

  // Build breadcrumb path for a block node using its page_id
  const buildBlockParentPath = useCallback((node: Node): string => {
    if (!node.page_uuid) return '';
    const page = allPages.find(p => p.uuid === node.page_uuid);
    if (!page) return '';
    const pageName = nodeNameToDisplayText(page, { dateFormat }) || 'Untitled';
    const ancestors = buildParentPath(page);
    // buildParentPath returns "Parent /" format; strip trailing " /" to combine cleanly
    const trimmed = ancestors.replace(/ \/$/, '');
    return trimmed ? `${trimmed} / ${pageName}` : pageName;
  }, [allPages, buildParentPath, dateFormat]);

  // Get display classes for a node
  const getDisplayClasses = useCallback((node: Node): Array<{ nodeUuid: string; name: string }> => {
    if (!node.classes_uuid || node.classes_uuid.length === 0) return [];
    return node.classes_uuid
      .map(classUuid => {
        const classNode = allClasses.find(c => c.uuid === classUuid);
        if (!classNode) return null;
        const name = nodeNameToDisplayText(classNode, { dateFormat });
        if (!name) return null;
        return { nodeUuid: classUuid, name };
      })
      .filter((c): c is { nodeUuid: string; name: string } => c !== null);
  }, [allClasses, dateFormat]);

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
        <div id={id} className={`node-selector node-selector--select node-selector--readonly ${className}`}>
          {hasValue ? (
            <div className="node-selector__selected-list">
              {nodes.map(node => (
                <button
                  key={node.uuid}
                  className="node-selector__chip node-selector__chip--readonly"
                  onClick={() => onNodeClick?.(node)}
                >
                  <NodeIcon icon={node.icon} isPage={node.is_page} size="xs" />
                  <span>{nodeNameToDisplayText(node, { dateFormat }) || 'Untitled'}</span>
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
      <div id={id} className={`node-selector node-selector--select ${multi ? 'node-selector--select-multi' : ''} ${className}`} ref={containerRef}>
        {multi ? (
          // Multi-select: flat layout with pills + separate arrow button
          <div className="node-selector__multi-trigger">
            <div className="node-selector__selected-pills">
              {nodes.map(node => (
                <NodeRef
                  key={node.uuid}
                  nodeUuid={node.uuid}
                  onClick={() => onNodeClick?.(node)}
                  onRemove={readOnly ? undefined : () => handleRemove(node)}
                  readOnly={readOnly}
                  rightIconHoverReveal={rightIconHoverReveal}
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
                      {nodeNameToDisplayText(node, { dateFormat }) || 'Untitled'}
                    </span>
                    {displayCls.length > 0 && (
                      <span className="node-selector__single-value-classes">
                        {displayCls.map(cls => (
                          <span key={cls.nodeUuid} className="node-selector__single-value-class-pill">{cls.name}</span>
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
        {multi && isPickerOpen && createPortal(
          <Card
            ref={menuRef}
            className="node-selector__dropdown node-selector__dropdown--portal"
            elevation="high"
            padding={false}
            role="dialog"
            aria-label="Select node"
            data-editor-companion
            style={{
              position: 'absolute',
              // top/left/maxHeight are set imperatively by Floating UI; hidden
              // until the first position is computed
              top: 0,
              left: 0,
              width: '17.5rem',
              visibility: 'hidden',
            }}
          >
            <SearchField
              ref={searchInputRef}
              icon={<AddIcon size="sm" />}
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={effectiveCreateNew ? 'Search or create...' : searchPlaceholder}
              aria-label={effectiveCreateNew ? 'Search or create' : searchPlaceholder}
              className="node-selector__search-field"
            />
            <FilterPills filters={appliedFilters} onRemove={handleRemoveFilter} />
            <div className="node-selector__list">
              <ResultsList
                mode="multi"
                items={multiDropdownItems}
                filterSuggestions={filterSuggestions}
                assignedIds={assignedIds}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                isLoading={isLoading}
                searchQuery={searchQuery}
                showCreateOption={showCreateOption}
                showMoreOption={false}
                dateSuggestion={dateSuggestion}
                buildParentPath={buildParentPath}
                buildBlockParentPath={buildBlockParentPath}
                getDisplayClasses={getDisplayClasses}
                allClasses={allClasses}
                onAdd={handleAdd}
                onToggle={handleToggle}
                onAddClassFilter={handleAddClassFilter}
                onAddBooleanFilter={handleAddBooleanFilter}
                onPrefixSelect={handlePrefixSelect}
                onCreateNew={handleCreateNew}
                onShowMore={handleShowMore}
              />
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
        {!multi && isPickerOpen && createPortal(
          <Card
            ref={menuRef}
            className="node-selector__dropdown node-selector__dropdown--portal"
            elevation="high"
            padding={false}
            role="dialog"
            aria-label="Select node"
            data-editor-companion
            style={
              menuPosition
                ? {
                    position: 'absolute',
                    top: `${menuPosition.top}px`,
                    left: `${menuPosition.left}px`,
                    minWidth: `${menuPosition.width}px`,
                    maxHeight: `${menuPosition.maxHeight}px`,
                  }
                : { position: 'absolute', top: 0, left: 0, visibility: 'hidden' }
            }
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
                aria-label={searchPlaceholder}
              />
            </div>
            
            {/* Filter pills */}
            <FilterPills filters={appliedFilters} onRemove={handleRemoveFilter} />
            
            {/* Results List */}
            <div className="node-selector__list">
              <ResultsList
                mode="single"
                items={filteredResults}
                filterSuggestions={filterSuggestions}
                assignedIds={assignedIds}
                selectedIndex={selectedIndex}
                setSelectedIndex={setSelectedIndex}
                isLoading={isLoading}
                searchQuery={searchQuery}
                showCreateOption={showCreateOption}
                showMoreOption={showMoreOption}
                convertCandidates={convertCandidates}
                dateSuggestion={dateSuggestion}
                buildParentPath={buildParentPath}
                buildBlockParentPath={buildBlockParentPath}
                getDisplayClasses={getDisplayClasses}
                allClasses={allClasses}
                onAdd={handleAdd}
                onAddClassFilter={handleAddClassFilter}
                onAddBooleanFilter={handleAddBooleanFilter}
                onPrefixSelect={handlePrefixSelect}
                onCreateNew={handleCreateNew}
                onShowMore={handleShowMore}
                onConvertToClass={onConvertToClass}
                onClosePicker={() => { setIsPickerOpen(false); setSearchQuery(''); setAppliedFilters([]); }}
              />
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
      <div id={id} className={`node-selector node-selector--inline ${className}`} data-editor-companion>
        <input
          ref={searchInputRef}
          type="text"
          className="node-selector__search"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <FilterPills filters={appliedFilters} onRemove={handleRemoveFilter} />
        <div className="node-selector__options">
          <ResultsList
            mode="search"
            items={filteredResults}
            filterSuggestions={filterSuggestions}
            assignedIds={assignedIds}
            selectedIndex={selectedIndex}
            setSelectedIndex={setSelectedIndex}
            isLoading={isLoading}
            searchQuery={searchQuery}
            showCreateOption={showCreateOption}
            showMoreOption={showMoreOption}
            convertCandidates={convertCandidates}
            dateSuggestion={dateSuggestion}
            buildParentPath={buildParentPath}
            buildBlockParentPath={buildBlockParentPath}
            getDisplayClasses={getDisplayClasses}
            allClasses={allClasses}
            onAdd={handleAdd}
            onAddClassFilter={handleAddClassFilter}
            onAddBooleanFilter={handleAddBooleanFilter}
            onPrefixSelect={handlePrefixSelect}
            onCreateNew={handleCreateNew}
            onShowMore={handleShowMore}
            onConvertToClass={onConvertToClass}
            onClosePicker={() => { setIsPickerOpen(false); setSearchQuery(''); setAppliedFilters([]); }}
            emptyClassName="node-selector__no-results"
          />
        </div>
      </div>
    );
  }

  // 'pill-row' mode: original behavior
  const showAddButton = !!onAdd;

  // Anchored mode: render only the picker panel portal, no trigger UI
  if (isAnchored) {
    return createPortal(
      <div
        className="node-selector__picker"
        ref={pickerRef}
        role="dialog"
        aria-label="Select node"
        data-editor-companion
        style={{ visibility: 'hidden' }}
      >
        <input
          ref={searchInputRef}
          type="text"
          className="node-selector__search"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <FilterPills filters={appliedFilters} onRemove={handleRemoveFilter} />
        <div className="node-selector__options">
          <ResultsList
            mode="search"
            items={filteredResults}
            filterSuggestions={filterSuggestions}
            assignedIds={assignedIds}
            selectedIndex={selectedIndex}
            setSelectedIndex={setSelectedIndex}
            isLoading={isLoading}
            searchQuery={searchQuery}
            showCreateOption={showCreateOption}
            showMoreOption={showMoreOption}
            dateSuggestion={dateSuggestion}
            buildParentPath={buildParentPath}
            buildBlockParentPath={buildBlockParentPath}
            getDisplayClasses={getDisplayClasses}
            allClasses={allClasses}
            onAdd={handleAdd}
            onAddClassFilter={handleAddClassFilter}
            onAddBooleanFilter={handleAddBooleanFilter}
            onPrefixSelect={handlePrefixSelect}
            onCreateNew={handleCreateNew}
            onShowMore={handleShowMore}
            emptyClassName="node-selector__no-results"
          />
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div id={id} className={`node-selector ${className}`}>
      {nodes.map((node) => {
        const isRemovable = onRemove && (!canRemove || canRemove(node));
        return (
          <NodeRef
            key={node.uuid}
            node={node}
            onClick={() => onNodeClick?.(node)}
            onRemove={isRemovable ? () => onRemove(node) : undefined}
            onColorChange={onColorChange ? (color) => onColorChange(node, color) : undefined}
            readOnly={readOnly}
            rightIconHoverReveal={rightIconHoverReveal}
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
            onClick={() => setIsPickerOpen((prev) => !prev)}
            onKeyDown={(e) => {
              // Prevent space/enter from closing the picker when it's already open.
              // Without this, the button retains focus briefly after opening and a
              // space keypress would toggle it closed before focus moves to the input.
              if (isPickerOpen && (e.key === ' ' || e.key === 'Enter')) {
                e.preventDefault();
              }
            }}
            title={emptyText}
            aria-label={emptyText || 'Add'}
          />
          
          {isPickerOpen && (
            <div
              className="node-selector__picker"
              ref={pickerRef}
              role="dialog"
              aria-label="Select node"
              data-editor-companion
              style={{ visibility: 'hidden' }}
            >
              <input
                ref={searchInputRef}
                type="text"
                className="node-selector__search"
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <FilterPills filters={appliedFilters} onRemove={handleRemoveFilter} />
              <div className="node-selector__options">
                <ResultsList
                  mode="search"
                  items={filteredResults}
                  filterSuggestions={filterSuggestions}
                  assignedIds={assignedIds}
                  selectedIndex={selectedIndex}
                  setSelectedIndex={setSelectedIndex}
                  isLoading={isLoading}
                  searchQuery={searchQuery}
                  showCreateOption={showCreateOption}
                  showMoreOption={showMoreOption}
                  convertCandidates={convertCandidates}
                  dateSuggestion={dateSuggestion}
                  buildParentPath={buildParentPath}
                  buildBlockParentPath={buildBlockParentPath}
                  getDisplayClasses={getDisplayClasses}
                  allClasses={allClasses}
                  onAdd={handleAdd}
                  onAddClassFilter={handleAddClassFilter}
                  onAddBooleanFilter={handleAddBooleanFilter}
                  onPrefixSelect={handlePrefixSelect}
                  onCreateNew={handleCreateNew}
                  onShowMore={handleShowMore}
                  onConvertToClass={onConvertToClass}
                  onClosePicker={() => { setIsPickerOpen(false); setSearchQuery(''); setAppliedFilters([]); }}
                  createIconSize="xs"
                  emptyClassName="node-selector__no-results"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

