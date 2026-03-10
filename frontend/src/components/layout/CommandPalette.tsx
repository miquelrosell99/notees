/**
 * CommandPalette - Floating search modal (Ctrl+K)
 * 
 * Features:
 * - Search all node names including parent hierarchy
 * - Pages section (with + Add page if no match)
 * - Blocks section  
 * - Auto-select first result for quick navigation
 * - Quick add section
 * - @classname syntax for filtering and creating pages with specific class
 * - @ triggers class suggestion popup for easy class selection
 */
import { useState, useCallback, useRef, useEffect, useMemo, useDeferredValue } from 'react';
import './CommandPalette.css';
import { useSearch, useCreateNode, useTodayNote, usePages, usePageClass, useHierarchicalPath, useClassClass, useProperties, useNodeNavigation, useClasses } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useCommandPaletteSearch } from '@/hooks/useCommandPaletteSearch';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import { listNodes, getOrCreateDaily, getOrCreateMonthly, getOrCreateYearly } from '@/api/nodes';
import { useAppStore, useSettingsStore, formatDate as formatDateWithPreference, formatMonth, formatYear } from '@/stores';
import type { Node, Property } from '@/types';
import { NodeIcon, BulletIcon, AddIcon, PropertiesIcon, CalendarIcon, ImportIcon } from '../core/icons';
import Icon from '@mdi/react';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { mdiExport, mdiDatabaseRefresh, mdiBrain, mdiFingerprint, mdiMerge } from '@mdi/js';
import { parseHierarchicalPath, resolveHierarchicalParent } from '@/utils/hierarchicalPath';
import { SuggestionPopup } from '../nodes/SuggestionPopup';
import { NodeRef } from '../nodes/NodeRef';
import { DuplicatePageModal } from './DuplicatePageModal';
import { CreatePageWithUuidModal } from './CreatePageWithUuidModal';
import { parseDate, generateDateUuid, type ParsedDate } from '@/utils/dateParser';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useNotifications } from '@/stores/notificationStore';

export interface CommandPaletteProps {
  /** Whether the palette is open */
  isOpen: boolean;
  /** Callback to close the palette */
  onClose: () => void;
  /** Callback when a node is selected */
  onSelect?: (node: Node) => void;
}

interface SearchResult {
  node?: Node;
  property?: Property;
  type: 'page' | 'block' | 'property';
  breadcrumb?: string;
}



/**
 * Parse query for @classname syntax
 * Returns the search term, optional class filter, and whether user is typing a class
 * Example: "Pokemon @creature" -> { searchTerm: "Pokemon", className: "creature", isTypingClass: false }
 * Example: "Pokemon @crea" -> { searchTerm: "Pokemon", className: null, isTypingClass: true, classQuery: "crea" }
 */
function parseQueryWithClass(query: string): { 
  searchTerm: string; 
  className: string | null;
  isTypingClass: boolean;
  classQuery: string;
} {
  // Check if user is actively typing after @ (no space after the class name yet)
  const typingMatch = query.match(/^(.*)@(\S*)$/);
  if (typingMatch) {
    const classQuery = typingMatch[2];
    // If there's a complete word after @ followed by nothing (user is still typing)
    return {
      searchTerm: typingMatch[1].trim(),
      className: null,
      isTypingClass: true,
      classQuery,
    };
  }
  
  // Check for completed @classname (has space after or is at end with complete word)
  const completedMatch = query.match(/^(.*)@(\S+)\s+$/);
  if (completedMatch) {
    return {
      searchTerm: completedMatch[1].trim(),
      className: completedMatch[2],
      isTypingClass: false,
      classQuery: '',
    };
  }
  
  return { searchTerm: query, className: null, isTypingClass: false, classQuery: '' };
}

// Max items shown per section — keeps render cost bounded
const MAX_PAGES = 8;
const MAX_BLOCKS = 8;
const MAX_PROPERTIES = 5;

/**
 * Result item component
 */
function ResultItem({
  result,
  isSelected,
  onClick,
  allNodes,
  allClasses,
  pageClassId,
}: {
  result: SearchResult;
  isSelected: boolean;
  onClick: () => void;
  allNodes?: Node[];
  allClasses?: Node[];
  pageClassId?: number | null;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  
  // Resolve aliased node name if this node is an alias
  const aliasedNodeName = result.node?.aliased_id && allNodes
    ? nodeNameToText(allNodes.find(n => n.id === result.node?.aliased_id)?.name) || 'Unknown'
    : null;
  
  // Scroll into view when selected
  useEffect(() => {
    if (isSelected && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);
  
  // Handle property results
  if (result.type === 'property' && result.property) {
    return (
      <button
        ref={ref}
        className={`command-palette__result ${isSelected ? 'command-palette__result--selected' : ''}`}
        onClick={onClick}
      >
        <div className="command-palette__result-row">
          <span className="command-palette__result-icon">
            {result.property.icon ? (
              <span style={{ fontSize: '1.2em' }}>{result.property.icon}</span>
            ) : (
              <PropertiesIcon size="sm" />
            )}
          </span>
          <span className="command-palette__result-content">
            <span className="command-palette__result-name">
              {result.property.name}
            </span>
          </span>
          <span className="command-palette__result-type">
            property
          </span>
        </div>
      </button>
    );
  }
  
  // Handle node results
  if (!result.node) return null;

  const classLabel = (result.node.classes ?? [])
    .filter(cid => cid !== pageClassId)
    .map(cid => allClasses?.find(c => c.id === cid))
    .filter((c): c is Node => c !== undefined)
    .map(c => nodeNameToText(c.name))
    .filter(Boolean)
    .join(', ');

  return (
    <button
      ref={ref}
      className={`command-palette__result ${isSelected ? 'command-palette__result--selected' : ''}`}
      onClick={onClick}
    >
      {result.breadcrumb && (
        <div className="command-palette__result-crumbs" title={result.breadcrumb}>
          {result.breadcrumb}
        </div>
      )}
      <div className="command-palette__result-row">
        <span className="command-palette__result-icon">
          {result.type === 'page' ? (
            <NodeIcon icon={getEffectiveIcon(result.node, allClasses)} isPage={true} size="sm" />
          ) : (
            <BulletIcon size="xs" />
          )}
        </span>
        <span className="command-palette__result-content">
          <span className="command-palette__result-name">
            {nodeNameToText(result.node.name) || 'Untitled'}
          </span>
        </span>
        {aliasedNodeName && (
          <span className="command-palette__result-alias">
            alias of: {aliasedNodeName}
          </span>
        )}
        {classLabel && (
          <span className="command-palette__result-type">
            {classLabel}
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * CommandPalette Component
 */
export function CommandPalette({
  isOpen,
  onClose,
  onSelect,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedClasses, setSelectedClasses] = useState<Node[]>([]);
  const [classPopupPosition, setClassPopupPosition] = useState<{ top: number; left: number } | null>(null);
  const [duplicateModal, setDuplicateModal] = useState<{
    isOpen: boolean;
    pageName: string;
    conflictingClasses: string[];
    originalClasses: number[];
    parentId: number | null;
  }>({ isOpen: false, pageName: '', conflictingClasses: [], originalClasses: [], parentId: null });
  const [createWithUuidModalOpen, setCreateWithUuidModalOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { openNode, openPropertyView } = useAppStore();
  const { quickAddDestination, dateFormat, showDevOptions } = useSettingsStore();
  const { navigateToNode } = useNodeNavigation();
  const { error: notifyError, warning: notifyWarning } = useNotifications();
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();
  const { data: allClasses } = useClasses();
  
  // Fetch all properties for search
  const { data: allProperties = [] } = useProperties();
  
  // Parse query for @classname syntax
  const { searchTerm, isTypingClass, classQuery } = useMemo(() => parseQueryWithClass(query), [query]);
  
  // Debounce the search term to avoid firing API calls on every keystroke
  const debouncedSearchTerm = useDeferredValue(isTypingClass ? '' : searchTerm);
  
  // Build class filter for search from selected classes
  const classFilter = selectedClasses.length > 0 
    ? selectedClasses.map(c => c.id).join(',')
    : undefined;
  
  // Search with optional class filter (debounced to avoid per-keystroke API calls)
  const { data: searchResults, isLoading: isSearchLoading } = useSearch(
    debouncedSearchTerm, 
    classFilter
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
  
  // All selectable items (pages, blocks, properties, quick-add actions)
  // Command definitions for the palette
  const commands = useMemo(() => {
    const cmds: Array<{ id: string; label: string; icon: 'import' | 'export' | 'maintenance' | 'focus' | 'uuid' | 'merge'; requiresPage?: boolean; devOnly?: boolean }> = [
      { id: 'import-logseq', label: 'Import Logseq', icon: 'import' },
      { id: 'import-markdown', label: 'Import Markdown files', icon: 'import' },
      { id: 'export-page', label: 'Export current page', icon: 'export', requiresPage: true },
      { id: 'rebuild-links', label: 'Rebuild links from AST', icon: 'maintenance' },
      { id: 'fix-raw-links', label: 'Fix raw UUID links', icon: 'maintenance', devOnly: true },
      { id: 'toggle-focus-mode', label: 'Toggle Focus Mode', icon: 'focus' },
      { id: 'merge-pages', label: 'Merge pages', icon: 'merge' },
      { id: 'create-page-with-uuid', label: 'Create page with custom UUID', icon: 'uuid', devOnly: true },
    ];
    return cmds.filter(cmd => !cmd.devOnly || showDevOptions);
  }, [showDevOptions]);

  const allItems = useMemo(() => {
      type ItemEntry = { type: 'page' | 'block' | 'property' | 'add-page' | 'quick-add' | 'date' | 'command'; result?: SearchResult; label?: string; parsedDate?: ParsedDate; existingNode?: Node; commandId?: string; commandIcon?: 'import' | 'export' | 'maintenance' | 'focus' | 'uuid' | 'merge' };
    const items: ItemEntry[] = [];
    
    // Commands section — show first when user is searching
    if (searchTerm.trim()) {
      const lowerSearch = searchTerm.toLowerCase();
      for (const cmd of commands) {
        if (cmd.label.toLowerCase().includes(lowerSearch)) {
          items.push({ type: 'command', label: cmd.label, commandId: cmd.id, commandIcon: cmd.icon });
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
    
    // Pages section — capped to MAX_PAGES
    const displayedPages = rawPages.slice(0, MAX_PAGES);
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
    
    // Blocks section — capped to MAX_BLOCKS
    const displayedBlocks = rawBlocks.slice(0, MAX_BLOCKS);
    displayedBlocks.forEach(({ node, breadcrumb }) =>
      items.push({ type: 'block', result: { node, type: 'block', breadcrumb } }),
    );
    
    // Properties section — capped to MAX_PROPERTIES
    const displayedProperties = rawProperties.slice(0, MAX_PROPERTIES);
    displayedProperties.forEach(prop =>
      items.push({ type: 'property', result: { property: prop, type: 'property' } }),
    );
    
    // Quick add option
    if (searchTerm.trim()) {
      items.push({ type: 'quick-add', label: `Quick add: "${searchTerm}"` });
    }
    
    return items;
  }, [rawPages, rawBlocks, rawProperties, searchTerm, pageNameForCreation, selectedClasses, parsedDate, existingDateNode, commands, formatParsedDateLabel, pageMap]);
  
  // Focus input when opened; refresh caches that may have gone stale since last open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedClasses([]);
      setClassPopupPosition(null);
      inputRef.current?.focus();
      queryClient.invalidateQueries({ queryKey: [...nodeKeys.all, 'pages'] });
      queryClient.invalidateQueries({ queryKey: nodeKeys.classes() });
    }
  }, [isOpen, queryClient]);
  
  // Calculate class popup position when typing @
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
    // Add class to selected classes if not already there
    if (!selectedClasses.find(c => c.id === classNode.id)) {
      setSelectedClasses(prev => [...prev, classNode]);
    }
    // Remove the @ text from query
    const beforeAt = query.substring(0, query.lastIndexOf('@'));
    setQuery(beforeAt.trim());
    // Keep focus on input
    inputRef.current?.focus();
  }, [query, selectedClasses]);
  
  // Handle removing a class pill
  const handleRemoveClass = useCallback((classId: number) => {
    setSelectedClasses(prev => prev.filter(c => c.id !== classId));
  }, []);
  
  // Handle creating a new class from popup
  const handleClassCreate = useCallback(async (name: string) => {
    if (!classClassId || !pageClassId) return;
    try {
      const newClass = await createNodeMutation.mutateAsync({
        name,
        classes: [classClassId, pageClassId],
      });
      // Add the new class to selected classes
      setSelectedClasses(prev => [...prev, newClass]);
      // Remove the @ text from query
      const beforeAt = query.substring(0, query.lastIndexOf('@'));
      setQuery(beforeAt.trim());
      inputRef.current?.focus();
    } catch (error) {
      notifyError('Failed to create class', 'Please try again.');
    }
  }, [classClassId, pageClassId, query, createNodeMutation]);
  
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
        if (item.result?.node) {
          if (onSelect) {
            onSelect(item.result.node);
          } else {
            navigateToNode(item.result.node);
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
          useAppStore.getState().setImportLogseqModalOpen(true);
        } else if (item.commandId === 'import-markdown') {
          useAppStore.getState().setImportMarkdownModalOpen(true);
        } else if (item.commandId === 'export-page') {
          const currentId = useAppStore.getState().currentNodeId;
          if (currentId) {
            useAppStore.getState().setExportPageModalOpen(true);
          }
        } else if (item.commandId === 'rebuild-links') {
          useAppStore.getState().setRebuildLinksModalOpen(true);
        } else if (item.commandId === 'fix-raw-links') {
          useAppStore.getState().setFixRawLinksModalOpen(true);
        } else if (item.commandId === 'merge-pages') {
          useAppStore.getState().setMergePagesModalOpen(true);
          onClose();
          return;
        } else if (item.commandId === 'toggle-focus-mode') {
          useAppStore.getState().toggleFocusMode();
        } else if (item.commandId === 'create-page-with-uuid') {
          setCreateWithUuidModalOpen(true);
          // Keep palette open — modal takes over; close palette so it doesn't layer underneath
          onClose();
          return;
        }
        onClose();
        break;
    }
  }, [allItems, searchTerm, pageNameForCreation, selectedClasses, pageClassId, destinationPage, onSelect, openNode, openPropertyView, createNodeMutation, onClose, queryClient]);
  
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
    listKeyDown(e);
  }, [isTypingClass, listKeyDown, onClose]);
  
  // Group items for rendering — pre-compute index maps to avoid O(n²) indexOf in JSX
  const { dateItems, pageItems, blockItems, propertyItems, quickAddItems, commandItems, indexMap, extraPages, extraBlocks, extraProperties } = useMemo(() => {
    const dateItems: typeof allItems = [];
    const pageItems: typeof allItems = [];
    const blockItems: typeof allItems = [];
    const propertyItems: typeof allItems = [];
    const quickAddItems: typeof allItems = [];
    const commandItems: typeof allItems = [];
    const indexMap = new Map<typeof allItems[number], number>();
    
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
      }
    }
    return { dateItems, pageItems, blockItems, propertyItems, quickAddItems, commandItems, indexMap,
      extraPages: Math.max(0, rawPages.length - MAX_PAGES),
      extraBlocks: Math.max(0, rawBlocks.length - MAX_BLOCKS),
      extraProperties: Math.max(0, rawProperties.length - MAX_PROPERTIES),
    };
  }, [allItems, rawPages.length, rawBlocks.length, rawProperties.length]);

  // Close on backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);
  
  return (
    <>
    <div className={`command-palette__backdrop${isOpen ? '' : ' command-palette__backdrop--hidden'}`} onClick={handleBackdropClick}>
      <div ref={containerRef} className="command-palette">
        <div className="command-palette__input-container">
          <input
            ref={inputRef}
            type="text"
            className="command-palette__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages, blocks, and properties..."
          />
          {/* Class pills */}
          {selectedClasses.length > 0 && (
            <div className="command-palette__class-pills">
              {selectedClasses.map(classNode => (
                <NodeRef
                  key={classNode.id}
                  node={classNode}
                  onRemove={() => handleRemoveClass(classNode.id)}
                  readOnly={false}
                />
              ))}
            </div>
          )}
          {isLoading && <span className="command-palette__spinner" aria-label="Searching" />}
          <kbd className="command-palette__shortcut">Esc</kbd>
        </div>
        
        {/* Class suggestion popup when typing @ */}
        {isTypingClass && classPopupPosition && (
          <SuggestionPopup
            isOpen={true}
            query={classQuery}
            type="class"
            position={classPopupPosition}
            onSelect={(node) => handleClassSelect(node)}
            onClose={() => {
              // Remove the @ when closing
              const beforeAt = query.substring(0, query.lastIndexOf('@'));
              setQuery(beforeAt);
            }}
            onCreate={handleClassCreate}
          />
        )}
        
        {/* Hierarchical path preview — hidden when date is detected */}
        {pathInfo && !isTypingClass && !parsedDate && (
          <div className="command-palette__path-preview">
            <span className="command-palette__path-label">Will create:</span>
            <span className="command-palette__path-segments">
              {pathInfo.segments.map((segment, index) => (
                <span key={index}>
                  {index > 0 && <span className="command-palette__path-separator"> → </span>}
                  <span className={segment.exists ? 'command-palette__path-segment--existing' : 'command-palette__path-segment--new'}>
                    {segment.name}
                    {segment.exists && <span className="command-palette__path-indicator" title="Page exists">✓</span>}
                  </span>
                </span>
              ))}
            </span>
          </div>
        )}
        
        <div className="command-palette__results">
          {isTypingClass ? (
            <div className="command-palette__hint">
              Type to search classes, press Enter to select
            </div>
          ) : (
            <>
              {query && allItems.length === 0 && !isLoading && (
                <div className="command-palette__empty">No results found</div>
              )}
              
              {!query && (
                <div className="command-palette__hint">
                  Start typing to search pages, blocks, and properties
                </div>
              )}
              
              {/* Commands section */}
              {commandItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Commands</div>
              {commandItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                return (
                  <button
                    key={item.commandId}
                    className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                    onClick={() => handleSelect(globalIndex)}
                  >
                    <div className="command-palette__result-row">
                      <span className="command-palette__result-icon">
                        {item.commandIcon === 'import' ? (
                          <ImportIcon size="sm" />
                        ) : item.commandIcon === 'maintenance' ? (
                          <Icon path={mdiDatabaseRefresh} size={0.7} />
                        ) : item.commandIcon === 'focus' ? (
                          <Icon path={mdiBrain} size={0.7} />
                        ) : item.commandIcon === 'uuid' ? (
                          <Icon path={mdiFingerprint} size={0.7} />
                        ) : item.commandIcon === 'merge' ? (
                          <Icon path={mdiMerge} size={0.7} />
                        ) : (
                          <Icon path={mdiExport} size={0.7} />
                        )}
                      </span>
                      <span className="command-palette__result-content">
                        <span className="command-palette__result-name">{item.label}</span>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

              {/* Date suggestion section */}
              {dateItems.length > 0 && (
                <div className="command-palette__section">
                  <div className="command-palette__section-header">Date Pages</div>
                  {dateItems.map((item) => {
                    const globalIndex = indexMap.get(item)!;
                    return (
                      <button
                        key="date-page"
                        className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                        onClick={() => handleSelect(globalIndex)}
                      >
                        <div className="command-palette__result-row">
                          <span className="command-palette__result-icon">
                            <CalendarIcon size="sm" />
                          </span>
                          <span className="command-palette__result-content">
                            <span className="command-palette__result-name">{item.label}</span>
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              
              {/* Pages section — hidden when date is detected */}
              {pageItems.length > 0 && !parsedDate && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">
                Pages{extraPages > 0 && <span className="command-palette__section-more"> +{extraPages} more</span>}
              </div>
              {pageItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                if (item.type === 'add-page') {
                  return (
                    <button
                      key="add-page"
                      className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <div className="command-palette__result-row">
                        <span className="command-palette__result-icon">
                          <AddIcon size="sm" />
                        </span>
                        <span className="command-palette__result-content">
                          <span className="command-palette__result-name">{item.label}</span>
                        </span>
                      </div>
                    </button>
                  );
                }
                return (
                  <ResultItem
                    key={item.result?.node?.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                    allNodes={searchResults}
                    allClasses={allClasses}
                    pageClassId={pageClassId}
                  />
                );
              })}
            </div>
          )}
          
          {/* Blocks section */}
          {blockItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">
                Blocks{extraBlocks > 0 && <span className="command-palette__section-more"> +{extraBlocks} more</span>}
              </div>
              {blockItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                return (
                  <ResultItem
                    key={item.result?.node?.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                    allNodes={searchResults}
                    allClasses={allClasses}
                    pageClassId={pageClassId}
                  />
                );
              })}
            </div>
          )}
          
          {/* Properties section */}
          {propertyItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">
                Properties{extraProperties > 0 && <span className="command-palette__section-more"> +{extraProperties} more</span>}
              </div>
              {propertyItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                return (
                  <ResultItem
                    key={item.result?.property?.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                  />
                );
              })}
            </div>
          )}
          
          {/* Quick Add section */}
          {quickAddItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Quick Add</div>
              {quickAddItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                return (
                  <button
                    key="quick-add"
                    className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                    onClick={() => handleSelect(globalIndex)}
                  >
                    <div className="command-palette__result-row">
                      <span className="command-palette__result-icon">
                        <AddIcon size="sm" />
                      </span>
                      <span className="command-palette__result-content">
                        <span className="command-palette__result-name">{item.label}</span>
                      </span>
                      <kbd className="command-palette__item-shortcut">⌘↵</kbd>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

            </>
          )}
        </div>
        
        <div className="command-palette__footer">
          <span className="command-palette__footer-hint">
            <kbd>↑</kbd><kbd>↓</kbd> to navigate
          </span>
          <span className="command-palette__footer-hint">
            <kbd>↵</kbd> to select
          </span>
          <span className="command-palette__footer-hint">
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
      
      {/* Duplicate page modal - shown when trying to create a page with an existing name */}
      <DuplicatePageModal
        isOpen={duplicateModal.isOpen}
        onClose={() => setDuplicateModal(prev => ({ ...prev, isOpen: false }))}
        pageName={duplicateModal.pageName}
        conflictingClasses={duplicateModal.conflictingClasses}
        originalClasses={duplicateModal.originalClasses}
        parentId={duplicateModal.parentId}
        onSuccess={(node) => {
          onClose();
          openNode(node.id);
        }}
      />

    </div>
    <CreatePageWithUuidModal
      isOpen={createWithUuidModalOpen}
      onClose={() => setCreateWithUuidModalOpen(false)}
      onSuccess={(node) => {
        setCreateWithUuidModalOpen(false);
        openNode(node.id);
      }}
    />
    </>
  );
}

export default CommandPalette;
