import { useState, useCallback, useRef, useEffect, useMemo, useDeferredValue } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types';
import type { RecentPage } from '@/api/nodes';
import {
  useSearch,
  useCreateNode,
  useTodayNote,
  usePages,
  usePageClass,
  useHierarchicalPath,
  useClassClass,
  useProperties,
  useClasses,
} from '@/features/content';
import { nodeNameToText } from '@/features/queries';
import { useCommandPaletteSearch } from '@/hooks/useCommandPaletteSearch';
import {
  getRecentPages,
  getRecentlyCreatedPages,
  getRandomPages,
} from '@/api/nodes';
import { useSettingsStore, formatDate as formatDateWithPreference, formatMonth, formatYear } from '@/stores';
import { useNotifications } from '@/stores/notificationStore';

import { parseDate, generateDateUuid, type ParsedDate } from '@/utils/dateParser';
import { nodeKeys } from '@/hooks/queryKeys';
import { parseQueryWithFilters } from '@/utils/searchFilters';
import { useCommandRegistry, type Command } from '@/stores/commandRegistry';
import type { AppliedFilter, DuplicateModalState } from './CommandPalette.types';
import {
  INITIAL_MAX_PAGES,
  INITIAL_MAX_BLOCKS,
  INITIAL_MAX_PROPERTIES,
} from './CommandPalette.types';

interface UseCommandPaletteStateParams {
  isOpen: boolean;
  onClose: () => void;
}

export function useCommandPaletteState({ isOpen, onClose }: UseCommandPaletteStateParams) {
  const [query, setQuery] = useState('');
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilter[]>([]);
  const [classPopupPosition, setClassPopupPosition] = useState<{ top: number; left: number } | null>(null);
  const [filterPrefixPopupPosition, setFilterPrefixPopupPosition] = useState<{ top: number; left: number } | null>(null);
  const [duplicateModal, setDuplicateModal] = useState<DuplicateModalState>({
    isOpen: false,
    pageName: '',
    conflictingClasses: [],
    originalClasses: [],
    parentId: null,
  });
  const [maxPages, setMaxPages] = useState(INITIAL_MAX_PAGES);
  const [maxBlocks, setMaxBlocks] = useState(INITIAL_MAX_BLOCKS);
  const [maxProperties, setMaxProperties] = useState(INITIAL_MAX_PROPERTIES);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { quickAddDestination, dateFormat } = useSettingsStore();

  const { error: notifyError } = useNotifications();
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();
  const { data: allClasses } = useClasses();

  // Fetch all properties for search
  const { data: allProperties = [] } = useProperties();

  // Derive selected classes from appliedFilters for backward compatibility
  const selectedClasses = useMemo(() =>
    appliedFilters.filter((f): f is AppliedFilter & { type: 'class' } => f.type === 'class').map(f => f.classNode),
    [appliedFilters]
  );

  // Parse query for filter prefix syntax (class:, uuid:, is_page:, etc.)
  const { searchTerm, isTypingFilter, activeFilter, suggestedPrefixes, uuidSearch, isTypingColon } = useMemo(
    () => parseQueryWithFilters(query, appliedFilters), [query, appliedFilters]
  );

  // For class filter: extract the class query from activeFilter
  const isTypingClass = isTypingFilter && activeFilter?.config.type === 'class';
  const classQuery = isTypingClass ? (activeFilter?.value ?? '') : '';

  // For boolean filter: check if typing a boolean option
  const isTypingBoolean = isTypingFilter && activeFilter?.config.type === 'boolean';
  const booleanOptions = isTypingBoolean && activeFilter?.config.options
    ? activeFilter.config.options.filter(opt => opt.startsWith(activeFilter.value.toLowerCase()))
    : [];

  // Debounce the search term to avoid firing API calls on every keystroke
  const debouncedSearchTerm = useDeferredValue(isTypingFilter ? '' : searchTerm);

  // Build class filter for search from applied class filters
  const classFilter = selectedClasses.length > 0
    ? selectedClasses.map(c => c.id).join(',')
    : undefined;

  // Build boolean filters from applied filters
  const booleanFilters = useMemo(() => {
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

  // Search with filters (debounced to avoid per-keystroke API calls)
  const { data: searchResults, isLoading: isSearchLoading } = useSearch(
    debouncedSearchTerm,
    {
      classFilters: classFilter,
      uuid: uuidSearch ?? undefined,
      ...booleanFilters,
    }
  );

  // Categorize results off the main thread via Web Worker
  const { results: { pages: rawPages, blocks: rawBlocks, properties: rawProperties }, isPending: isCategorizingPending } = useCommandPaletteSearch(
    searchResults,
    allProperties,
    debouncedSearchTerm,
  );

  // Show loading when typing, waiting for API, or worker is categorizing
  const isLoading = isSearchLoading || isCategorizingPending || (searchTerm !== debouncedSearchTerm && searchTerm.length > 0);

  // Get destination page for quick add
  const { data: todayNote } = useTodayNote();
  const { data: allPages } = usePages({ includeChildren: true });

  // O(1) page lookup map for building parent breadcrumbs
  const pageMap = useMemo(() => {
    const map = new Map<number, Node>();
    for (const p of allPages ?? []) map.set(p.id, p);
    return map;
  }, [allPages]);
  const inboxPage = allPages?.find(p => nodeNameToText(p.name) === 'Inbox');
  const destinationPage = quickAddDestination === 'today' ? todayNote : inboxPage;

  // Analyze hierarchical path structure (use searchTerm without the @class part)
  const pathInfo = useHierarchicalPath(searchTerm, true);

  // Display name for page creation (without @class suffix)
  const pageNameForCreation = searchTerm.trim();

  // Parse query for date formats
  const parsedDate = useMemo(() => parseDate(searchTerm), [searchTerm]);

  // Check if the date page already exists by looking up its deterministic UUID
  const existingDateNode = useMemo(() => {
    if (!parsedDate || !allPages) return null;
    const uuid = generateDateUuid(parsedDate);
    return allPages.find(p => p.uuid === uuid) ?? null;
  }, [parsedDate, allPages]);

  // Query client for cache invalidation after date page creation
  const queryClient = useQueryClient();

  // Format date label using user's date format preference
  const formatParsedDateLabel = useCallback((pd: ParsedDate): string => {
    if (pd.type === 'year') {
      return formatYear(pd.year);
    }
    if (pd.type === 'month' && pd.month) {
      return formatMonth(pd.year, pd.month, dateFormat);
    }
    if (pd.type === 'day' && pd.month && pd.day) {
      const date = new Date(pd.year, pd.month - 1, pd.day);
      return formatDateWithPreference(date, dateFormat);
    }
    return pd.label;
  }, [dateFormat]);

  // Command definitions for the palette — read from the global CommandRegistry.
  // Read the raw Map (stable reference) and derive the palette list in useMemo
  // instead of using getPaletteCommands() directly, because the latter returns a
  // new array on every call and triggers React's "getSnapshot should be cached"
  // infinite-loop warning when used as a Zustand selector.
  const allCommands = useCommandRegistry((state) => state.commands);
  const commands = useMemo<Command[]>(
    () => Array.from(allCommands.values()).filter((c) => c.palette && c.palette.visible !== false),
    [allCommands]
  );

  // Empty-state sections: recently accessed, recently created, random pages
  const [recentAccessedPages, setRecentAccessedPages] = useState<RecentPage[]>([]);
  const [recentCreatedPages, setRecentCreatedPages] = useState<RecentPage[]>([]);
  const [randomPages, setRandomPages] = useState<RecentPage[]>([]);

  // Reset section limits when search query changes
  useEffect(() => {
    setMaxPages(INITIAL_MAX_PAGES);
      setMaxBlocks(INITIAL_MAX_BLOCKS);
      setMaxProperties(INITIAL_MAX_PROPERTIES);;
  }, [debouncedSearchTerm]);

  // Focus input when opened; refresh caches that may have gone stale since last open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
        setAppliedFilters([]);
        setClassPopupPosition(null);
        setMaxPages(INITIAL_MAX_PAGES);
        setMaxBlocks(INITIAL_MAX_BLOCKS);
        setMaxProperties(INITIAL_MAX_PROPERTIES);;
      inputRef.current?.focus();
      queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
      // Fetch empty-state sections
      getRecentPages(5).then(setRecentAccessedPages).catch(() => {});
      getRecentlyCreatedPages(5).then(setRecentCreatedPages).catch(() => {});
      getRandomPages(5).then(setRandomPages).catch(() => {});
    }
  }, [isOpen, queryClient]);

  // Calculate class popup position when typing class: filter
  useEffect(() => {
    if (isTypingClass && inputRef.current) {
      const inputRect = inputRef.current.getBoundingClientRect();

      // Position below the input (use screen coordinates for fixed positioning)
      setClassPopupPosition({
        top: inputRect.bottom + 4,
        left: inputRect.left,
      });
    } else {
      setClassPopupPosition(null);
    }
  }, [isTypingClass]);

  // Calculate filter prefix popup position when typing a standalone colon
  useEffect(() => {
    if (isTypingColon && inputRef.current) {
      const inputRect = inputRef.current.getBoundingClientRect();
      setFilterPrefixPopupPosition({
        top: inputRect.bottom + 4,
        left: inputRect.left,
      });
    } else {
      setFilterPrefixPopupPosition(null);
    }
  }, [isTypingColon]);

  // Handle class selection from popup
  const handleClassSelect = useCallback((classNode: Node) => {
    // Add class to applied filters if not already there
    if (!selectedClasses.find(c => c.id === classNode.id)) {
      setAppliedFilters(prev => [...prev, { type: 'class', classNode }]);
    }
    // Remove the class: text from query
    const beforeFilter = query.replace(/\S+:\S*$/, '').trim();
    setQuery(beforeFilter);
    // Keep focus on input
    inputRef.current?.focus();
  }, [query, selectedClasses]);

  // Handle removing a filter pill
  const handleRemoveFilter = useCallback((index: number) => {
    setAppliedFilters(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Handle selecting a boolean filter option
  const handleBooleanSelect = useCallback((value: boolean) => {
    if (!activeFilter || activeFilter.config.type !== 'boolean') return;
    // Check if this boolean filter is already applied
    const existing = appliedFilters.findIndex(
      f => f.type === 'boolean' && f.prefix === activeFilter.prefix
    );
    const newFilter: AppliedFilter = {
      type: 'boolean',
      prefix: activeFilter.prefix,
      label: activeFilter.config.label,
      value,
    };
    if (existing >= 0) {
      setAppliedFilters(prev => prev.map((f, i) => i === existing ? newFilter : f));
    } else {
      setAppliedFilters(prev => [...prev, newFilter]);
    }
    // Remove the filter text from query
    const beforeFilter = query.replace(/\S+:\S*$/, '').trim();
    setQuery(beforeFilter);
    inputRef.current?.focus();
  }, [activeFilter, appliedFilters, query]);

  // Handle selecting a suggested prefix (auto-complete it)
  const handlePrefixSelect = useCallback((prefix: string) => {
    // Replace the partial text at end of query with the full prefix:
    const beforePartial = query.replace(/\S+$/, '');
    setQuery(beforePartial + prefix + ':');
    inputRef.current?.focus();
  }, [query]);

  // Handle selecting a filter prefix from the standalone-colon popup
  const handleFilterPrefixSelect = useCallback((prefix: string) => {
    const beforeColon = query.replace(/\s*:$/, '');
    setQuery(beforeColon ? `${beforeColon} ${prefix}:` : `${prefix}:`);
    inputRef.current?.focus();
  }, [query]);

  // Close the standalone-colon popup and remove the trailing colon
  const handleFilterPrefixClose = useCallback(() => {
    const beforeColon = query.replace(/\s*:$/, '');
    setQuery(beforeColon);
    inputRef.current?.focus();
  }, [query]);

  // Handle creating a new class from popup
  const handleClassCreate = useCallback(async (name: string) => {
    if (!classClassId || !pageClassId) return;
    try {
      const newClass = await createNodeMutation.mutateAsync({
        name,
        classes: [classClassId, pageClassId],
      });
      // Add the new class to applied filters
      setAppliedFilters(prev => [...prev, { type: 'class', classNode: newClass }]);
      // Remove the class: text from query
      const beforeFilter = query.replace(/\S+:\S*$/, '').trim();
      setQuery(beforeFilter);
      inputRef.current?.focus();
    } catch {
      notifyError('Failed to create class', 'Please try again.');
    }
  }, [classClassId, pageClassId, query, createNodeMutation, notifyError]);

  // Refresh random pages
  const refreshRandomPages = useCallback(async () => {
    try {
      const pages = await getRandomPages(5);
      setRandomPages(pages);
    } catch {
      // ignore
    }
  }, []);

  // Close on backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);

  return {
    query,
    setQuery,
    appliedFilters,
    setAppliedFilters,
    classPopupPosition,
    setClassPopupPosition,
    filterPrefixPopupPosition,
    setFilterPrefixPopupPosition,
    duplicateModal,
    setDuplicateModal,
    maxPages,
    setMaxPages,
    maxBlocks,
    setMaxBlocks,
    maxProperties,
    setMaxProperties,
    inputRef,
    containerRef,
    selectedClasses,
    searchTerm,
    isTypingFilter,
    activeFilter,
    suggestedPrefixes,
    uuidSearch,
    isTypingClass,
    classQuery,
    isTypingBoolean,
    booleanOptions,
    isTypingColon,
    debouncedSearchTerm,
    classFilter,
    booleanFilters,
    searchResults,
    rawPages,
    rawBlocks,
    rawProperties,
    isLoading,
    todayNote,
    allPages,
    pageMap,
    inboxPage,
    destinationPage,
    pathInfo,
    pageNameForCreation,
    parsedDate,
    existingDateNode,
    queryClient,
    formatParsedDateLabel,
    commands,
    recentAccessedPages,
    recentCreatedPages,
    randomPages,
    refreshRandomPages,
    handleClassSelect,
    handleRemoveFilter,
    handleBooleanSelect,
    handlePrefixSelect,
    handleFilterPrefixSelect,
    handleFilterPrefixClose,
    handleClassCreate,
    handleBackdropClick,
    pageClassId,
    allClasses,
    classClassId,
    createNodeMutation,
    allProperties,
  };
}
