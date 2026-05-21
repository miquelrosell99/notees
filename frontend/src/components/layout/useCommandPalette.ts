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
  useNodeNavigation,
} from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useCommandPaletteSearch } from '@/hooks/useCommandPaletteSearch';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import {
  listNodes,
  getOrCreateDaily,
  getOrCreateMonthly,
  getOrCreateYearly,
  getRecentPages,
  getRecentlyCreatedPages,
  getRandomPages,
} from '@/api/nodes';
import { resetNodeViews } from '@/api/nodeViews';
import { useNavigationStore, useModalStore, useSettingsStore, formatDate as formatDateWithPreference, formatMonth, formatYear } from '@/stores';
import { useNotifications } from '@/stores/notificationStore';
import { parseHierarchicalPath, resolveHierarchicalParent } from '@/utils/hierarchicalPath';
import { parseDate, generateDateUuid, type ParsedDate } from '@/utils/dateParser';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
import { parseQueryWithFilters } from './CommandPalette.utils';
import type {
  CommandPaletteProps,
  AppliedFilter,
  ItemEntry,
  GroupedItems,
  DuplicateModalState,
  CommandDef,
} from './CommandPalette.types';
import { createEmptyQueryAST } from '@/types/queryAST';
import type { QueryAST, StyleCondition } from '@/types/queryAST';
import {
  INITIAL_MAX_PAGES,
  INITIAL_MAX_BLOCKS,
  INITIAL_MAX_PROPERTIES,
  EXPAND_INCREMENT,
} from './CommandPalette.types';

export function useCommandPalette({ isOpen, onClose, onSelect }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilter[]>([]);
  const [classPopupPosition, setClassPopupPosition] = useState<{ top: number; left: number } | null>(null);
  const [duplicateModal, setDuplicateModal] = useState<DuplicateModalState>({
    isOpen: false,
    pageName: '',
    conflictingClasses: [],
    originalClasses: [],
    parentId: null,
  });
  const [createWithUuidModalOpen, setCreateWithUuidModalOpen] = useState(false);
  const [maxPages, setMaxPages] = useState(INITIAL_MAX_PAGES);
  const [maxBlocks, setMaxBlocks] = useState(INITIAL_MAX_BLOCKS);
  const [maxProperties, setMaxProperties] = useState(INITIAL_MAX_PROPERTIES);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { openNode, openPropertyView, openNodeCollection, openNodeCollectionFromNodes } = useNavigationStore();
  const { quickAddDestination, dateFormat, showDevOptions } = useSettingsStore();
  const { navigateToNode: _navigateToNode } = useNodeNavigation();
  const { error: notifyError, warning: notifyWarning, success: notifySuccess } = useNotifications();
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
  const { searchTerm, isTypingFilter, activeFilter, suggestedPrefixes, uuidSearch } = useMemo(
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

  // Command definitions for the palette
  const commands = useMemo<CommandDef[]>(() => {
    const cmds: CommandDef[] = [
      { id: 'import-logseq', label: 'Import Logseq', icon: 'import' },
      { id: 'import-logseq-folder', label: 'Import Logseq Markdown folder', icon: 'import' },
      { id: 'import-markdown', label: 'Import Markdown files', icon: 'import' },
      { id: 'export-page', label: 'Export current page', icon: 'export', requiresPage: true },
      { id: 'rebuild-links', label: 'Rebuild links from AST', icon: 'maintenance' },
      { id: 'fix-raw-links', label: 'Fix raw UUID links', icon: 'maintenance', devOnly: true },
      { id: 'toggle-focus-mode', label: 'Toggle Focus Mode', icon: 'focus' },
      { id: 'merge-pages', label: 'Merge pages', icon: 'merge' },
      { id: 'create-page-with-uuid', label: 'Create page with custom UUID', icon: 'uuid', devOnly: true },
      { id: 'reset-views', label: 'Reset views to defaults (current node)', icon: 'maintenance', requiresPage: true, devOnly: true },
      { id: 'open-random-page', label: 'Open random page', icon: 'random' },
      { id: 'toggle-minimap', label: 'Toggle minimap', icon: 'minimap' },
      { id: 'toggle-local-graph', label: 'Toggle local graph', icon: 'graph', requiresPage: true },
      { id: 'open-broken-links', label: 'Open node list: Broken links', icon: 'maintenance' },
    ];
    return cmds.filter(cmd => !cmd.devOnly || showDevOptions);
  }, [showDevOptions]);

  // Empty-state sections: recently accessed, recently created, random pages
  const [recentAccessedPages, setRecentAccessedPages] = useState<RecentPage[]>([]);
  const [recentCreatedPages, setRecentCreatedPages] = useState<RecentPage[]>([]);
  const [randomPages, setRandomPages] = useState<RecentPage[]>([]);

  const allItems = useMemo<ItemEntry[]>(() => {
    const items: ItemEntry[] = [];

    // When no query and no filters, show browse sections
    if (!searchTerm.trim() && !uuidSearch && appliedFilters.length === 0) {
      for (const page of recentAccessedPages) {
        items.push({ type: 'browse-page', result: { node: page as unknown as Node, type: 'page' }, browseSection: 'recent-accessed' });
      }
      for (const page of recentCreatedPages) {
        items.push({ type: 'browse-page', result: { node: page as unknown as Node, type: 'page' }, browseSection: 'recent-created' });
      }
      for (const page of randomPages) {
        items.push({ type: 'browse-page', result: { node: page as unknown as Node, type: 'page' }, browseSection: 'random' });
      }
      return items;
    }

    // Boolean option dropdown — when typing a boolean filter like is_page:
    if (isTypingBoolean && booleanOptions.length > 0) {
      for (const opt of booleanOptions) {
        items.push({ type: 'boolean-option', label: `${activeFilter!.prefix}:${opt}`, booleanValue: opt === 'true' });
      }
      return items;
    }

    // Filter prefix suggestions — when typing partial prefix
    if (suggestedPrefixes.length > 0) {
      for (const fp of suggestedPrefixes) {
        items.push({ type: 'filter-prefix', label: `${fp.prefix}: — ${fp.description}`, filterPrefix: fp });
      }
    }

    // Commands section — show first when user is searching
    if (searchTerm.trim() && !uuidSearch) {
      const lowerSearch = searchTerm.toLowerCase();
      for (const cmd of commands) {
        if (cmd.label.toLowerCase().includes(lowerSearch)) {
          items.push({ type: 'command', label: cmd.label, commandId: cmd.id, commandIcon: cmd.icon, commandDevOnly: cmd.devOnly });
        }
      }
    }

    // Date suggestion (shown at top if query matches a date format)
    if (parsedDate) {
      const formattedDate = formatParsedDateLabel(parsedDate);
      const dateTypeLabel = parsedDate.type === 'day' ? 'daily' : parsedDate.type === 'month' ? 'monthly' : 'yearly';
      if (existingDateNode) {
        items.push({ type: 'date', label: `Go to ${dateTypeLabel} page: ${formattedDate}`, parsedDate, existingNode: existingDateNode });
      } else {
        items.push({ type: 'date', label: `Create ${dateTypeLabel} page: ${formattedDate}`, parsedDate });
      }
    }

    // Pages section — capped to maxPages (expandable)
    const displayedPages = rawPages.slice(0, maxPages);
    displayedPages.forEach(({ node }) => {
      // Build ancestor breadcrumb using allPages map (worker only has search results)
      let breadcrumb: string | undefined;
      if (node.parent_id != null) {
        const parts: string[] = [];
        let current = pageMap.get(node.parent_id);
        while (current) {
          parts.unshift(nodeNameToText(current.name) || 'Untitled');
          current = current.parent_id != null ? pageMap.get(current.parent_id) : undefined;
        }
        if (parts.length > 0) breadcrumb = parts.join(' / ');
      }
      items.push({ type: 'page', result: { node, type: 'page', breadcrumb } });
    });
    if (rawPages.length > maxPages) {
      items.push({ type: 'show-more', showMoreSection: 'pages', showMoreCount: rawPages.length - maxPages });
    }

    // Add page option — always show when there's a name to create
    const classLabels = selectedClasses.length > 0
      ? ` with ${selectedClasses.length === 1 ? `class "${nodeNameToText(selectedClasses[0].name)}"` : `${selectedClasses.length} classes`}`
      : '';
    const hasExactMatch = displayedPages.some(({ node }) => nodeNameToText(node.name)?.toLowerCase() === pageNameForCreation.toLowerCase());
    if (pageNameForCreation) {
      const label = hasExactMatch
        ? `Create another "${pageNameForCreation}"${classLabels || ' (pick a class to differentiate)'}`
        : `Create page "${pageNameForCreation}"${classLabels}`;
      items.push({ type: 'add-page', label });
    }

    // Blocks section — capped to maxBlocks (expandable)
    const displayedBlocks = rawBlocks.slice(0, maxBlocks);
    displayedBlocks.forEach(({ node, breadcrumb }) =>
      items.push({ type: 'block', result: { node, type: 'block', breadcrumb } }),
    );
    if (rawBlocks.length > maxBlocks) {
      items.push({ type: 'show-more', showMoreSection: 'blocks', showMoreCount: rawBlocks.length - maxBlocks });
    }

    // Properties section — capped to maxProperties (expandable)
    const displayedProperties = rawProperties.slice(0, maxProperties);
    displayedProperties.forEach(prop =>
      items.push({ type: 'property', result: { property: prop, type: 'property' } }),
    );
    if (rawProperties.length > maxProperties) {
      items.push({ type: 'show-more', showMoreSection: 'properties', showMoreCount: rawProperties.length - maxProperties });
    }

    // Quick add option
    if (searchTerm.trim()) {
      items.push({ type: 'quick-add', label: `Quick add: "${searchTerm}"` });
    }

    return items;
  }, [rawPages, rawBlocks, rawProperties, searchTerm, pageNameForCreation, selectedClasses, parsedDate, existingDateNode, commands, formatParsedDateLabel, pageMap, recentAccessedPages, recentCreatedPages, randomPages, maxPages, maxBlocks, maxProperties, uuidSearch, appliedFilters, isTypingBoolean, booleanOptions, suggestedPrefixes, activeFilter]);

  // Reset section limits when search query changes
  useEffect(() => {
    setMaxPages(INITIAL_MAX_PAGES);
    setMaxBlocks(INITIAL_MAX_BLOCKS);
    setMaxProperties(INITIAL_MAX_PROPERTIES);
  }, [debouncedSearchTerm]);

  // Focus input when opened; refresh caches that may have gone stale since last open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setAppliedFilters([]);
      setClassPopupPosition(null);
      setMaxPages(INITIAL_MAX_PAGES);
      setMaxBlocks(INITIAL_MAX_BLOCKS);
      setMaxProperties(INITIAL_MAX_PROPERTIES);
      inputRef.current?.focus();
      queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'pages'] });
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
    } catch (error) {
      notifyError('Failed to create class', 'Please try again.');
    }
  }, [classClassId, pageClassId, query, createNodeMutation, notifyError]);

  // Handle selection
  const handleSelect = useCallback(async (index: number) => {
    const item = allItems[index];
    if (!item) return;

    switch (item.type) {
      case 'date': {
        // Navigate to date page — use existing if found, create if not
        const pd = item.parsedDate;
        if (!pd) break;
        try {
          let dateNode: Node;
          if (item.existingNode) {
            // Page already exists, navigate directly
            dateNode = item.existingNode;
          } else {
            // Create the date page via API
            if (pd.type === 'day' && pd.month && pd.day) {
              const dateStr = `${pd.year}-${String(pd.month).padStart(2, '0')}-${String(pd.day).padStart(2, '0')}`;
              dateNode = await getOrCreateDaily(dateStr);
            } else if (pd.type === 'month' && pd.month) {
              dateNode = await getOrCreateMonthly(pd.year, pd.month);
            } else {
              dateNode = await getOrCreateYearly(pd.year);
            }
            // Invalidate caches so the new page appears everywhere
            queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'pages'] });
            queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
            queryClient.invalidateQueries({ queryKey: nodeKeys.dailyList() });
          }
          if (onSelect) {
            onSelect(dateNode);
          } else {
            openNode(dateNode.id);
          }
        } catch (error) {
          notifyError('Failed to navigate to date', 'Could not open or create the date page.');
        }
        onClose();
        break;
      }

      case 'page':
      case 'block':
      case 'browse-page':
        if (item.result?.node) {
          if (onSelect) {
            onSelect(item.result.node);
          } else {
            openNode(item.result.node.id);
          }
        }
        onClose();
        break;

      case 'property':
        if (item.result?.property) {
          openPropertyView(item.result.property.id);
        }
        onClose();
        break;

      case 'add-page':
        // Create new page with hierarchical path support (e.g., "Pokemon/Charizard")
        // and optional class from @classname syntax
        try {
          if (!pageClassId) {
            notifyWarning('Setup incomplete', 'Page class not found. Please reload the app.');
            break;
          }

          const parsed = parseHierarchicalPath(pageNameForCreation);
          let parentId: number | null = null;

          // Build classes array - always include page class, plus any selected classes
          const classes = [pageClassId, ...selectedClasses.map(c => c.id)];

          // If hierarchical path, create parent pages as needed
          if (parsed.isHierarchical) {
            // Fetch fresh pages from API to avoid stale cache issues
            const freshPages = await listNodes({ pages_only: true, include_children: true });
            parentId = await resolveHierarchicalParent(
              parsed.parentSegments,
              freshPages,
              async (name, parent) => {
                return await createNodeMutation.mutateAsync({
                  name,
                  parent_id: parent,
                  classes: [pageClassId], // Parent pages get just the page class
                });
              }
            );
          }

          // Create the final page (leaf of the path) with all classes
          try {
            const newNode = await createNodeMutation.mutateAsync({
              name: parsed.leaf || pageNameForCreation,
              parent_id: parentId,
              classes,
            });
            onClose();
            openNode(newNode.id);
          } catch (createErr: unknown) {
            const axiosErr = createErr as { response?: { status?: number; data?: { detail?: { message?: string; conflicting_classes?: string[] } | string } } };
            if (axiosErr.response?.status === 409) {
              // Show the duplicate page modal to let user pick a class
              const detail = axiosErr.response.data?.detail;
              const conflicting = typeof detail === 'object' && detail !== null ? (detail.conflicting_classes || []) : [];
              setDuplicateModal({
                isOpen: true,
                pageName: parsed.leaf || pageNameForCreation,
                conflictingClasses: conflicting,
                originalClasses: classes,
                parentId: parentId,
              });
            } else {
              notifyError('Failed to create page', 'Please try again.');
            }
          }
        } catch (error) {
          notifyError('Failed to create page', 'Please try again.');
        }
        break;

      case 'quick-add':
        // Quick add as block (to daily page or inbox) with selected classes
        if (!destinationPage) {
          notifyWarning('No destination', 'Set a Quick Add destination in settings.');
          break;
        }
        try {
          await createNodeMutation.mutateAsync({
            name: searchTerm.trim(),
            parent_id: destinationPage.id,
            classes: selectedClasses.map(c => c.id),
          });
        } catch (error) {
          notifyError('Failed to add item', 'Please try again.');
        }
        onClose();
        break;

      case 'command':
        if (item.commandId === 'import-logseq') {
          useModalStore.getState().setImportLogseqModalOpen(true);
        } else if (item.commandId === 'import-logseq-folder') {
          useModalStore.getState().setImportLogseqFolderModalOpen(true);
        } else if (item.commandId === 'import-markdown') {
          useModalStore.getState().setImportMarkdownModalOpen(true);
        } else if (item.commandId === 'export-page') {
          const currentId = useNavigationStore.getState().currentNodeId;
          if (currentId) {
            useModalStore.getState().setExportPageModalOpen(true);
          }
        } else if (item.commandId === 'rebuild-links') {
          useModalStore.getState().setRebuildLinksModalOpen(true);
        } else if (item.commandId === 'fix-raw-links') {
          useModalStore.getState().setFixRawLinksModalOpen(true);
        } else if (item.commandId === 'merge-pages') {
          useModalStore.getState().setMergePagesModalOpen(true);
          onClose();
          return;
        } else if (item.commandId === 'toggle-focus-mode') {
          useNavigationStore.getState().toggleFocusMode();
        } else if (item.commandId === 'create-page-with-uuid') {
          setCreateWithUuidModalOpen(true);
          // Keep palette open — modal takes over; close palette so it doesn't layer underneath
          onClose();
          return;
        } else if (item.commandId === 'reset-views') {
          const currentId = useNavigationStore.getState().currentNodeId;
          if (currentId) {
            try {
              await resetNodeViews(currentId);
              queryClient.removeQueries({ queryKey: nodeViewKeys.details() });
              queryClient.removeQueries({ queryKey: nodeViewKeys.queryResults() });
              queryClient.invalidateQueries({ queryKey: nodeViewKeys.list(currentId) });
              queryClient.invalidateQueries({ queryKey: nodeViewKeys.byType(currentId) });
              notifySuccess('Views reset', 'All views for this node have been reset to defaults.');
            } catch {
              notifyError('Failed to reset views', 'Please try again.');
            }
          }
        } else if (item.commandId === 'open-random-page') {
          try {
            const pages = await getRandomPages(1);
            if (pages.length > 0) {
              openNode(pages[0].id);
            } else {
              notifyWarning('No pages', 'No pages found in workspace.');
            }
          } catch {
            notifyError('Failed to open random page', 'Please try again.');
          }
        } else if (item.commandId === 'toggle-minimap') {
          useModalStore.getState().toggleMinimap();
        } else if (item.commandId === 'toggle-local-graph') {
          const currentId = useNavigationStore.getState().currentNodeId;
          if (currentId) {
            useNavigationStore.getState().openLocalGraph(currentId);
          }
        } else if (item.commandId === 'open-broken-links') {
          const brokenLinksQuery: QueryAST = {
            ...createEmptyQueryAST(),
            scope: { type: 'scope', scope_type: 'entire_workspace' },
            root_group: {
              type: 'group',
              logic: 'AND',
              children: [
                {
                  type: 'condition',
                  condition_type: 'style',
                  style_type: 'broken_link',
                  operator: 'is',
                } as StyleCondition,
              ],
            },
          };
          openNodeCollection('Broken links', brokenLinksQuery);
        }
        onClose();
        break;

      case 'show-more':
        if (item.showMoreSection === 'pages') {
          setMaxPages(prev => prev + EXPAND_INCREMENT);
        } else if (item.showMoreSection === 'blocks') {
          setMaxBlocks(prev => prev + EXPAND_INCREMENT);
        } else if (item.showMoreSection === 'properties') {
          setMaxProperties(prev => prev + EXPAND_INCREMENT);
        }
        return; // Don't close the palette

      case 'filter-prefix':
        if (item.filterPrefix) {
          handlePrefixSelect(item.filterPrefix.prefix);
        }
        return; // Don't close the palette

      case 'boolean-option':
        if (item.booleanValue !== undefined) {
          handleBooleanSelect(item.booleanValue);
        }
        return; // Don't close the palette
    }
  }, [allItems, searchTerm, pageNameForCreation, selectedClasses, pageClassId, destinationPage, onSelect, openNode, openPropertyView, createNodeMutation, onClose, queryClient, handlePrefixSelect, handleBooleanSelect]);

  // Keyboard list navigation
  const { selectedIndex, handleKeyDown: listKeyDown } = useKeyboardListNav({
    totalItems: allItems.length,
    onSelect: handleSelect,
    onClose,
    isOpen,
  });

  // Wrap to let SuggestionPopup handle keyboard when class popup is open
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isTypingClass) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      return;
    }
    // Ctrl+Enter opens all search results in a temporary NodeCollection view
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (searchResults && searchResults.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        openNodeCollectionFromNodes(
          searchTerm.trim() ? `Search: "${searchTerm}"` : 'Search results',
          searchResults,
        );
        onClose();
        return;
      }
      // Fall back to quick-add when no search results
      const quickAddIndex = allItems.findIndex(item => item.type === 'quick-add');
      if (quickAddIndex !== -1) {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(quickAddIndex);
        return;
      }
    }
    listKeyDown(e);
  }, [isTypingClass, searchResults, searchTerm, allItems, handleSelect, listKeyDown, onClose, openNodeCollectionFromNodes]);

  // Group items for rendering — pre-compute index maps to avoid O(n²) indexOf in JSX
  const groupedItems = useMemo<GroupedItems>(() => {
    const dateItems: ItemEntry[] = [];
    const pageItems: ItemEntry[] = [];
    const blockItems: ItemEntry[] = [];
    const propertyItems: ItemEntry[] = [];
    const quickAddItems: ItemEntry[] = [];
    const commandItems: ItemEntry[] = [];
    const filterPrefixItems: ItemEntry[] = [];
    const booleanOptionItems: ItemEntry[] = [];
    const browseRecentAccessed: ItemEntry[] = [];
    const browseRecentCreated: ItemEntry[] = [];
    const browseRandom: ItemEntry[] = [];
    const indexMap = new Map<ItemEntry, number>();

    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      indexMap.set(item, i);
      switch (item.type) {
        case 'date': dateItems.push(item); break;
        case 'page': case 'add-page': pageItems.push(item); break;
        case 'block': blockItems.push(item); break;
        case 'property': propertyItems.push(item); break;
        case 'quick-add': quickAddItems.push(item); break;
        case 'command': commandItems.push(item); break;
        case 'filter-prefix': filterPrefixItems.push(item); break;
        case 'boolean-option': booleanOptionItems.push(item); break;
        case 'show-more':
          if (item.showMoreSection === 'pages') pageItems.push(item);
          else if (item.showMoreSection === 'blocks') blockItems.push(item);
          else if (item.showMoreSection === 'properties') propertyItems.push(item);
          break;
        case 'browse-page':
          if (item.browseSection === 'recent-accessed') browseRecentAccessed.push(item);
          else if (item.browseSection === 'recent-created') browseRecentCreated.push(item);
          else if (item.browseSection === 'random') browseRandom.push(item);
          break;
      }
    }
    return { dateItems, pageItems, blockItems, propertyItems, quickAddItems, commandItems, filterPrefixItems, booleanOptionItems, browseRecentAccessed, browseRecentCreated, browseRandom, indexMap };
  }, [allItems]);

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
    classPopupPosition,
    duplicateModal,
    setDuplicateModal,
    createWithUuidModalOpen,
    setCreateWithUuidModalOpen,
    inputRef,
    containerRef,
    isOpen,
    isTypingClass,
    isTypingFilter,
    classQuery,
    isTypingBoolean,
    booleanOptions,
    suggestedPrefixes,
    isLoading,
    searchTerm,
    debouncedSearchTerm,
    uuidSearch,
    parsedDate,
    pathInfo,
    allItems,
    selectedIndex,
    handleKeyDown,
    handleSelect,
    handleClassSelect,
    handleRemoveFilter,
    handleBooleanSelect,
    handlePrefixSelect,
    handleClassCreate,
    handleBackdropClick,
    groupedItems,
    pageClassId,
    allClasses,
    allPages,
    searchResults,
    openNode,
  };
}
