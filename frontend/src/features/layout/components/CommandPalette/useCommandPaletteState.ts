import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types';
import { useProperties } from '@/features/properties';
import { useSearch, useCreateNode, useTodayNote, usePages, useClassClass, useClasses, useSearchClasses, useRecents } from '@/features/content';
import { nodeNameToText } from '@/features/queries';
import { useCommandPaletteSearch } from '@/hooks/useCommandPaletteSearch';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { useSettingsStore, formatDate as formatDateWithPreference, formatMonth, formatYear } from '@/stores';
import { useNotifications } from '@/stores/notificationStore';

import { parseDate, generateDateUuid, type ParsedDate } from '@/utils/dateParser';
import { nodeKeys } from '@/hooks/queryKeys';
import { parseQueryWithFilters } from '@/utils/searchFilters';
import { useCommandRegistry, type Command } from '@/stores/commandRegistry';
import { useCapabilities } from '@/config/capabilities';
import type { AppliedFilter, DuplicateModalState } from './CommandPalette.types';
import {
  INITIAL_MAX_PAGES,
  INITIAL_MAX_CLASSES,
  INITIAL_MAX_BLOCKS,
  INITIAL_MAX_PROPERTIES,
} from './CommandPalette.types';

function shufflePages(pages: Node[]): Node[] {
  const shuffled = [...pages];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

interface UseCommandPaletteStateParams {
  isOpen: boolean;
  onClose: () => void;
}

export function useCommandPaletteState({ isOpen, onClose }: UseCommandPaletteStateParams) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const [query, setQuery] = useState('');
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilter[]>([]);
  const [duplicateModal, setDuplicateModal] = useState<DuplicateModalState>({
    isOpen: false,
    pageName: '',
    conflictingClasses: [],
    originalClasses: [],
    parentUuid: null,
  });
  const [maxPages, setMaxPages] = useState(INITIAL_MAX_PAGES);
  const [maxClasses, setMaxClasses] = useState(INITIAL_MAX_CLASSES);
  const [maxBlocks, setMaxBlocks] = useState(INITIAL_MAX_BLOCKS);
  const [maxProperties, setMaxProperties] = useState(INITIAL_MAX_PROPERTIES);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const quickAddDestination = useSettingsStore((s) => s.quickAddDestination);
  const dateFormat = useSettingsStore((s) => s.dateFormat);

  const { error: notifyError } = useNotifications();
  const createNodeMutation = useCreateNode();
  const { classClassUuid } = useClassClass();
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
  const debouncedSearchTerm = useDebouncedValue(isTypingFilter ? '' : searchTerm, 150);

  // Build class filter for search from applied class filters
  const classFilter = selectedClasses.length > 0
    ? selectedClasses.map(c => c.uuid).join(',')
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

  // Search with filters (debounced and capped to keep the palette snappy on
  // large workspaces; only the first page/block pages are ever displayed).
  const { data: searchResults, isLoading: isSearchLoading } = useSearch(
    debouncedSearchTerm,
    {
      classFilters: classFilter,
      nodeUuid: uuidSearch ?? undefined,
      limit: 50,
      ...booleanFilters,
    }
  );

  // Categorize results off the main thread via Web Worker
  const { results: { pages: rawPages, blocks: rawBlocks, properties: rawProperties }, isPending: isCategorizingPending } = useCommandPaletteSearch(
    searchResults,
    allProperties,
    debouncedSearchTerm,
  );

  // Class results live in the dedicated class table (not in node search
  // results), so they are matched client-side by name, like properties.
  const { data: rawClasses } = useSearchClasses(debouncedSearchTerm);

  // Show loading when typing, waiting for API, or worker is categorizing
  const isLoading = isSearchLoading || isCategorizingPending || (searchTerm !== debouncedSearchTerm && searchTerm.length > 0);

  // Get destination page for quick add
  const { data: todayNote } = useTodayNote();
  const { data: allPages } = usePages({ includeChildren: true });

  // O(1) page lookup map for building parent breadcrumbs
  const pageMap = useMemo(() => {
    const map = new Map<string, Node>();
    for (const p of allPages ?? []) map.set(p.uuid, p);
    return map;
  }, [allPages]);
  const inboxPage = allPages?.find(p => nodeNameToText(p.name) === 'Inbox');
  const destinationPage = quickAddDestination === 'today' ? todayNote : inboxPage;

  // Display name for page creation (without @class suffix)
  const pageNameForCreation = searchTerm.trim();

  // Parse query for date formats
  const parsedDate = useMemo(() => parseDate(searchTerm), [searchTerm]);
  const datePageUuid = useMemo(
    () => (parsedDate ? generateDateUuid(parsedDate) : null),
    [parsedDate]
  );

  // Check if the date page already exists by projecting its deterministic UUID
  // directly from the worker. This avoids depending on the full allPages list,
  // which can time out on large workspaces.
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');
  const { data: existingDateNode = null } = useQuery({
    queryKey: nodeKeys.detail(datePageUuid ?? '', { include_children: false }),
    queryFn: async (): Promise<Node | null> => {
      if (!client || !datePageUuid) return null;
      return (await client.query<Node | undefined>('projectNode', [datePageUuid])) ?? null;
    },
    enabled: !!client && !!datePageUuid,
    placeholderData: null,
  });

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
  const capabilities = useCapabilities();
  const commands = useMemo<Command[]>(
    // Commands bound to a server capability are hidden when it is unavailable
    // (e.g. import/export or workspace switching in local mode).
    () => Array.from(allCommands.values()).filter(
      (c) => c.palette && c.palette.visible !== false && (!c.capability || capabilities[c.capability]),
    ),
    [allCommands, capabilities]
  );

  // Empty-state sections: recently accessed, recently created, random pages
  const { data: recentAccessedItems } = useRecents(5);
  const recentAccessedPages = useMemo<Node[]>(() => {
    const items = recentAccessedItems ?? [];
    const pages: Node[] = [];
    for (const item of items) {
      const node = pageMap.get(item.nodeUuid);
      if (node) pages.push(node);
    }
    return pages;
  }, [recentAccessedItems, pageMap]);
  const [recentCreatedPages, setRecentCreatedPages] = useState<Node[]>([]);
  const [randomPages, setRandomPages] = useState<Node[]>([]);

  // Reset section limits when search query changes
  useEffect(() => {
    setMaxPages(INITIAL_MAX_PAGES);
    setMaxClasses(INITIAL_MAX_CLASSES);
    setMaxBlocks(INITIAL_MAX_BLOCKS);
    setMaxProperties(INITIAL_MAX_PROPERTIES);
  }, [debouncedSearchTerm]);

  // Focus input when opened and derive empty-state sections from the cached
  // allPages list. Avoid issuing additional all-pages worker queries here:
  // usePages already loads the page list, and queueing extra projections on a
  // large workspace starves the worker and makes palette search feel frozen.
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setAppliedFilters([]);
      setMaxPages(INITIAL_MAX_PAGES);
      setMaxClasses(INITIAL_MAX_CLASSES);
      setMaxBlocks(INITIAL_MAX_BLOCKS);
      setMaxProperties(INITIAL_MAX_PROPERTIES);
      inputRef.current?.focus();
      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });

      if (allPages) {
        const sorted = [...allPages]
          .sort((a, b) => new Date(b.create_date).getTime() - new Date(a.create_date).getTime())
          .slice(0, 5);
        setRecentCreatedPages(sorted);
        setRandomPages(shufflePages(allPages).slice(0, 5));
      }
    }
  }, [isOpen, queryClient, workspaceUuid, allPages]);

  // Handle class selection from popup
  const handleClassSelect = useCallback((classNode: Node) => {
    // Add class to applied filters if not already there
    if (!selectedClasses.find(c => c.uuid === classNode.uuid)) {
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
    if (!classClassUuid) return;
    try {
      const newClass = await createNodeMutation.mutateAsync({
        name,
        kind: 'page',
        class_uuids: [classClassUuid],
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
  }, [classClassUuid, query, createNodeMutation, notifyError]);

  // Refresh random pages from the already-loaded page list
  const refreshRandomPages = useCallback(() => {
    if (allPages) {
      setRandomPages(shufflePages(allPages).slice(0, 5));
    }
  }, [allPages]);

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
    duplicateModal,
    setDuplicateModal,
    maxPages,
    setMaxPages,
    maxClasses,
    setMaxClasses,
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
    rawClasses,
    rawBlocks,
    rawProperties,
    isLoading,
    todayNote,
    allPages,
    pageMap,
    inboxPage,
    destinationPage,
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
    allClasses,
    classClassUuid,
    createNodeMutation,
    allProperties,
  };
}
