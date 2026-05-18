/**
 * CommandPalette - Floating search modal (Ctrl+K)
 * 
 * Features:
 * - Search all node names including parent hierarchy
 * - Pages section (with + Add page if no match)
 * - Blocks section  
 * - Auto-select first result for quick navigation
 * - Quick add section
 * - Filter prefix system: class:, uuid:, is_page:, is_class:, is_daily:
 * - class: triggers class suggestion popup for easy class selection
 */
import './CommandPalette.css';
import { useState, useCallback, useRef, useEffect, useMemo, useDeferredValue } from 'react';
import { useSearch, useCreateNode, useTodayNote, usePages, usePageClass, useHierarchicalPath, useClassClass, useProperties, useNodeNavigation, useClasses } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useCommandPaletteSearch } from '@/hooks/useCommandPaletteSearch';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import { listNodes, getOrCreateDaily, getOrCreateMonthly, getOrCreateYearly, getRecentPages, getRecentlyCreatedPages, getRandomPages } from '@/api/nodes';
import type { RecentPage } from '@/api/nodes';
import { resetNodeViews } from '@/api/nodeViews';
import { useNavigationStore, useModalStore, useSettingsStore, formatDate as formatDateWithPreference, formatMonth, formatYear } from '@/stores';
import type { Node, Property } from '@/types';
import { NodeIcon, BulletIcon, AddIcon, PropertiesIcon, CalendarIcon, ImportIcon } from '@/components/core/icons';
import Icon from '@mdi/react';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import { mdiExport, mdiDatabaseRefresh, mdiBrain, mdiFingerprint, mdiMerge, mdiShuffle, mdiMap, mdiGraphOutline, mdiFilter } from '@mdi/js';
import { parseHierarchicalPath, resolveHierarchicalParent } from '@/utils/hierarchicalPath';
import { SuggestionPopup } from '@/components/nodes/SuggestionPopup';
import { NodeRef } from '@/components/nodes/NodeRef';
import { DuplicatePageModal } from './DuplicatePageModal';
import { CreatePageWithUuidModal } from './CreatePageWithUuidModal';
import { parseDate, generateDateUuid, type ParsedDate } from '@/utils/dateParser';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/hooks/useNodeViews';
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
 * Filter prefix configuration for the command palette.
 * Supports: class dropdown, text input (uuid), and boolean dropdowns.
 */
interface FilterPrefixConfig {
  prefix: string;
  label: string;
  description: string;
  type: 'class' | 'text' | 'boolean';
  options?: string[]; // For boolean type
}

const FILTER_PREFIXES: FilterPrefixConfig[] = [
  { prefix: 'uuid', label: 'UUID', description: 'Find node by UUID', type: 'text' },
  { prefix: 'class', label: 'Class', description: 'Filter by class', type: 'class' },
  { prefix: 'is_page', label: 'Is Page', description: 'Filter pages or blocks', type: 'boolean', options: ['true', 'false'] },
  { prefix: 'is_class', label: 'Is Class', description: 'Filter class definitions', type: 'boolean', options: ['true', 'false'] },
  { prefix: 'is_daily', label: 'Is Daily', description: 'Filter daily notes', type: 'boolean', options: ['true', 'false'] },
];

/** An applied filter (shown as a pill below the input) */
type AppliedFilter = 
  | { type: 'class'; classNode: Node }
  | { type: 'boolean'; prefix: string; label: string; value: boolean };

interface ParsedFilters {
  /** Remaining search text after removing filter syntax */
  searchTerm: string;
  /** Active filter being typed (prefix:value in progress) */
  activeFilter: { prefix: string; value: string; config: FilterPrefixConfig } | null;
  /** Whether user is actively typing a filter value */
  isTypingFilter: boolean;
  /** Matching prefix suggestions (when user types partial prefix without colon) */
  suggestedPrefixes: FilterPrefixConfig[];
  /** UUID being searched for (when query is uuid:value) */
  uuidSearch: string | null;
}

/**
 * Parse query for filter prefix syntax (prefix:value).
 * Replaces the old @classname system with a general property:value approach.
 * 
 * Examples:
 *   "Pokemon class:crea" -> typing class filter, classQuery="crea"
 *   "uuid:abc-123" -> UUID search
 *   "is_page:true" -> boolean filter applied
 *   "hello cla" -> suggests "class:" prefix
 */
function parseQueryWithFilters(query: string, appliedFilters: AppliedFilter[]): ParsedFilters {
  // Check for active filter being typed: "text prefix:value" at end of query
  const filterMatch = query.match(/^(.*?)(\S+):(\S*)$/);
  if (filterMatch) {
    const beforeFilter = filterMatch[1].trim();
    const prefix = filterMatch[2].toLowerCase();
    const value = filterMatch[3];
    const config = FILTER_PREFIXES.find(f => f.prefix === prefix);
    
    if (config) {
      // UUID is a direct search, not a filter pill
      if (config.type === 'text') {
        return {
          searchTerm: beforeFilter,
          activeFilter: { prefix, value, config },
          isTypingFilter: true,
          suggestedPrefixes: [],
          uuidSearch: prefix === 'uuid' && value ? value : null,
        };
      }
      
      // Boolean filter: check if value is complete
      if (config.type === 'boolean') {
        const boolVal = value.toLowerCase();
        if (boolVal === 'true' || boolVal === 'false') {
          // Value is complete — but only auto-apply when user adds a space after
          // (leave it as "typing" until the space triggers completion in the component)
        }
        return {
          searchTerm: beforeFilter,
          activeFilter: { prefix, value, config },
          isTypingFilter: true,
          suggestedPrefixes: [],
          uuidSearch: null,
        };
      }
      
      // Class filter: show dropdown
      return {
        searchTerm: beforeFilter,
        activeFilter: { prefix, value, config },
        isTypingFilter: true,
        suggestedPrefixes: [],
        uuidSearch: null,
      };
    }
  }
  
  // Also support the "prefix:" with no value yet (user just typed the colon)
  const colonMatch = query.match(/^(.*?)(\S+):$/);
  if (colonMatch) {
    const prefix = colonMatch[2].toLowerCase();
    const config = FILTER_PREFIXES.find(f => f.prefix === prefix);
    if (config) {
      return {
        searchTerm: colonMatch[1].trim(),
        activeFilter: { prefix, value: '', config },
        isTypingFilter: true,
        suggestedPrefixes: [],
        uuidSearch: null,
      };
    }
  }
  
  // Check for partial prefix match (user might be starting to type a filter)
  const lastWord = query.match(/(\S+)$/);
  if (lastWord && !lastWord[1].includes(':')) {
    const partial = lastWord[1].toLowerCase();
    // Only suggest if at least 2 chars to avoid noise
    if (partial.length >= 2) {
      // Don't suggest prefixes that are already applied as filters
      const appliedPrefixes = new Set(appliedFilters.filter(f => f.type === 'boolean').map(f => (f as { prefix: string }).prefix));
      const matching = FILTER_PREFIXES.filter(f => 
        f.prefix.startsWith(partial) && !appliedPrefixes.has(f.prefix)
      );
      if (matching.length > 0) {
        return {
          searchTerm: query,
          activeFilter: null,
          isTypingFilter: false,
          suggestedPrefixes: matching,
          uuidSearch: null,
        };
      }
    }
  }
  
  return { searchTerm: query, activeFilter: null, isTypingFilter: false, suggestedPrefixes: [], uuidSearch: null };
}

// Initial items shown per section — expandable via "Show more"
const INITIAL_MAX_PAGES = 8;
const INITIAL_MAX_BLOCKS = 8;
const INITIAL_MAX_PROPERTIES = 5;
const EXPAND_INCREMENT = 20;

/**
 * Highlights matching substrings in text
 */
function HighlightText({ text, highlight }: { text: string; highlight: string }) {
  if (!highlight.trim()) return <>{text}</>;
  const regex = new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part)
          ? <mark key={i} className="command-palette__highlight">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </>
  );
}

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
  searchTerm = '',
}: {
  result: SearchResult;
  isSelected: boolean;
  onClick: () => void;
  allNodes?: Node[];
  allClasses?: Node[];
  pageClassId?: number | null;
  searchTerm?: string;
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
              <HighlightText text={result.property.name} highlight={searchTerm} />
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

  const displayClasses = (result.node.classes ?? [])
    .filter(cid => cid !== pageClassId)
    .map(cid => allClasses?.find(c => c.id === cid))
    .filter((c): c is Node => c !== undefined)
    .map(c => ({ id: c.id, name: nodeNameToText(c.name) }))
    .filter(cls => cls.name);

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
          ) : (() => {
            const effectiveIcon = getEffectiveIcon(result.node, allClasses);
            return effectiveIcon
              ? <NodeIcon icon={effectiveIcon} isPage={false} size="sm" />
              : <BulletIcon size="xs" />;
          })()}
        </span>
        <span className="command-palette__result-content">
          <span className="command-palette__result-name">
            <HighlightText text={nodeNameToText(result.node.name) || 'Untitled'} highlight={searchTerm} />
          </span>
        </span>
        {aliasedNodeName && (
          <span className="command-palette__result-alias">
            alias of: {aliasedNodeName}
          </span>
        )}
        {displayClasses.length > 0 && (
          <span className="node-result-item__class-pills">
            {displayClasses.map(cls => (
              <span key={cls.id} className="node-result-item__class-pill">{cls.name}</span>
            ))}
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
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilter[]>([]);
  const [classPopupPosition, setClassPopupPosition] = useState<{ top: number; left: number } | null>(null);
  const [duplicateModal, setDuplicateModal] = useState<{
    isOpen: boolean;
    pageName: string;
    conflictingClasses: string[];
    originalClasses: number[];
    parentId: number | null;
  }>({ isOpen: false, pageName: '', conflictingClasses: [], originalClasses: [], parentId: null });
  const [createWithUuidModalOpen, setCreateWithUuidModalOpen] = useState(false);
  const [maxPages, setMaxPages] = useState(INITIAL_MAX_PAGES);
  const [maxBlocks, setMaxBlocks] = useState(INITIAL_MAX_BLOCKS);
  const [maxProperties, setMaxProperties] = useState(INITIAL_MAX_PROPERTIES);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { openNode, openPropertyView } = useNavigationStore();
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
  
  // All selectable items (pages, blocks, properties, quick-add actions)
  // Command definitions for the palette
  const commands = useMemo(() => {
    const cmds: Array<{ id: string; label: string; icon: 'import' | 'export' | 'maintenance' | 'focus' | 'uuid' | 'merge' | 'random' | 'minimap' | 'graph'; requiresPage?: boolean; devOnly?: boolean }> = [
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
    ];
    return cmds.filter(cmd => !cmd.devOnly || showDevOptions);
  }, [showDevOptions]);

  // Empty-state sections: recently accessed, recently created, random pages
  const [recentAccessedPages, setRecentAccessedPages] = useState<RecentPage[]>([]);
  const [recentCreatedPages, setRecentCreatedPages] = useState<RecentPage[]>([]);
  const [randomPages, setRandomPages] = useState<RecentPage[]>([]);

  const allItems = useMemo(() => {
      type ItemEntry = { type: 'page' | 'block' | 'property' | 'add-page' | 'quick-add' | 'date' | 'command' | 'browse-page' | 'show-more' | 'filter-prefix' | 'boolean-option'; result?: SearchResult; label?: string; parsedDate?: ParsedDate; existingNode?: Node; commandId?: string; commandIcon?: 'import' | 'export' | 'maintenance' | 'focus' | 'uuid' | 'merge' | 'random' | 'minimap' | 'graph'; commandDevOnly?: boolean; browseSection?: 'recent-accessed' | 'recent-created' | 'random'; showMoreSection?: 'pages' | 'blocks' | 'properties'; showMoreCount?: number; filterPrefix?: FilterPrefixConfig; booleanValue?: boolean };
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
    // Modifier+Enter triggers quick-add directly
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      const quickAddIndex = allItems.findIndex(item => item.type === 'quick-add');
      if (quickAddIndex !== -1) {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(quickAddIndex);
        return;
      }
    }
    listKeyDown(e);
  }, [isTypingClass, listKeyDown, onClose, allItems, handleSelect]);
  
  // Group items for rendering — pre-compute index maps to avoid O(n²) indexOf in JSX
  const { dateItems, pageItems, blockItems, propertyItems, quickAddItems, commandItems, filterPrefixItems, booleanOptionItems, browseRecentAccessed, browseRecentCreated, browseRandom, indexMap } = useMemo(() => {
    const dateItems: typeof allItems = [];
    const pageItems: typeof allItems = [];
    const blockItems: typeof allItems = [];
    const propertyItems: typeof allItems = [];
    const quickAddItems: typeof allItems = [];
    const commandItems: typeof allItems = [];
    const filterPrefixItems: typeof allItems = [];
    const booleanOptionItems: typeof allItems = [];
    const browseRecentAccessed: typeof allItems = [];
    const browseRecentCreated: typeof allItems = [];
    const browseRandom: typeof allItems = [];
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
            placeholder={appliedFilters.length > 0 ? "Search with active filters..." : "Search pages, blocks, properties... (try class: uuid: is_page:)"}
          />
          {/* Filter pills — classes + boolean filters */}
          {appliedFilters.length > 0 && (
            <div className="command-palette__class-pills">
              {appliedFilters.map((filter, idx) => (
                filter.type === 'class' ? (
                  <NodeRef
                    key={`class-${filter.classNode.id}`}
                    node={filter.classNode}
                    onRemove={() => handleRemoveFilter(idx)}
                    readOnly={false}
                  />
                ) : (
                  <span key={`bool-${filter.prefix}`} className="command-palette__filter-pill">
                    <span className="command-palette__filter-pill-text">{filter.prefix}:{String(filter.value)}</span>
                    <button 
                      className="command-palette__filter-pill-remove" 
                      onClick={() => handleRemoveFilter(idx)}
                      aria-label={`Remove ${filter.label} filter`}
                    >×</button>
                  </span>
                )
              ))}
            </div>
          )}
          {isLoading && <span className="command-palette__spinner" aria-label="Searching" />}
          <kbd className="command-palette__shortcut">Esc</kbd>
        </div>
        
        {/* Class suggestion popup when typing class: filter */}
        {isTypingClass && classPopupPosition && (
          <SuggestionPopup
            isOpen={true}
            query={classQuery}
            type="class"
            position={classPopupPosition}
            onSelect={(node) => handleClassSelect(node)}
            onClose={() => {
              // Remove the class: filter text when closing
              const beforeFilter = query.replace(/\S+:\S*$/, '').trim();
              setQuery(beforeFilter);
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
              {query && allItems.length === 0 && !isLoading && !isTypingFilter && (
                <div className="command-palette__empty">No results found</div>
              )}
              
              {/* Boolean option dropdown */}
              {booleanOptionItems.length > 0 && (
                <div className="command-palette__section">
                  <div className="command-palette__section-header">Select Value</div>
                  {booleanOptionItems.map((item) => {
                    const globalIndex = indexMap.get(item)!;
                    return (
                      <button
                        key={item.label}
                        className={`command-palette__result ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                        onClick={() => handleSelect(globalIndex)}
                      >
                        <div className="command-palette__result-row">
                          <span className="command-palette__result-icon">
                            <Icon path={mdiFilter} size={0.7} />
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
              
              {/* Filter prefix suggestions */}
              {filterPrefixItems.length > 0 && (
                <div className="command-palette__section">
                  <div className="command-palette__section-header">Filters</div>
                  {filterPrefixItems.map((item) => {
                    const globalIndex = indexMap.get(item)!;
                    return (
                      <button
                        key={item.filterPrefix?.prefix}
                        className={`command-palette__result ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                        onClick={() => handleSelect(globalIndex)}
                      >
                        <div className="command-palette__result-row">
                          <span className="command-palette__result-icon">
                            <Icon path={mdiFilter} size={0.7} />
                          </span>
                          <span className="command-palette__result-content">
                            <span className="command-palette__result-name">{item.filterPrefix?.prefix}:</span>
                            <span className="command-palette__result-description">{item.filterPrefix?.description}</span>
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              
              {!query && appliedFilters.length === 0 && (
                <>
                  {browseRecentAccessed.length > 0 && (
                    <div className="command-palette__section">
                      <div className="command-palette__section-header">Recently Accessed</div>
                      {browseRecentAccessed.map((item) => {
                        const globalIndex = indexMap.get(item)!;
                        return (
                          <ResultItem
                            key={item.result?.node?.id}
                            result={item.result!}
                            isSelected={selectedIndex === globalIndex}
                            onClick={() => handleSelect(globalIndex)}
                            allNodes={allPages}
                            allClasses={allClasses}
                            pageClassId={pageClassId}
                          />
                        );
                      })}
                    </div>
                  )}
                  {browseRecentCreated.length > 0 && (
                    <div className="command-palette__section">
                      <div className="command-palette__section-header">Recently Created</div>
                      {browseRecentCreated.map((item) => {
                        const globalIndex = indexMap.get(item)!;
                        return (
                          <ResultItem
                            key={item.result?.node?.id}
                            result={item.result!}
                            isSelected={selectedIndex === globalIndex}
                            onClick={() => handleSelect(globalIndex)}
                            allNodes={allPages}
                            allClasses={allClasses}
                            pageClassId={pageClassId}
                          />
                        );
                      })}
                    </div>
                  )}
                  {browseRandom.length > 0 && (
                    <div className="command-palette__section">
                      <div className="command-palette__section-header">Random Pages</div>
                      {browseRandom.map((item) => {
                        const globalIndex = indexMap.get(item)!;
                        return (
                          <ResultItem
                            key={item.result?.node?.id}
                            result={item.result!}
                            isSelected={selectedIndex === globalIndex}
                            onClick={() => handleSelect(globalIndex)}
                            allNodes={allPages}
                            allClasses={allClasses}
                            pageClassId={pageClassId}
                          />
                        );
                      })}
                    </div>
                  )}
                </>
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
                        ) : item.commandIcon === 'random' ? (
                          <Icon path={mdiShuffle} size={0.7} />
                        ) : item.commandIcon === 'minimap' ? (
                          <Icon path={mdiMap} size={0.7} />
                        ) : item.commandIcon === 'graph' ? (
                          <Icon path={mdiGraphOutline} size={0.7} />
                        ) : (
                          <Icon path={mdiExport} size={0.7} />
                        )}
                      </span>
                      <span className="command-palette__result-content">
                        <span className="command-palette__result-name">{item.label}</span>
                      </span>
                      {item.commandDevOnly && (
                        <span className="command-palette__result-dev-badge">DEV</span>
                      )}
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
                Pages
              </div>
              {pageItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                if (item.type === 'show-more') {
                  return (
                    <button
                      key="show-more-pages"
                      className={`command-palette__result command-palette__result--show-more ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <span className="command-palette__show-more-label">Show {item.showMoreCount} more pages</span>
                    </button>
                  );
                }
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
                    searchTerm={debouncedSearchTerm}
                  />
                );
              })}
            </div>
          )}
          
          {/* Blocks section */}
          {blockItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">
                Blocks
              </div>
              {blockItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                if (item.type === 'show-more') {
                  return (
                    <button
                      key="show-more-blocks"
                      className={`command-palette__result command-palette__result--show-more ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <span className="command-palette__show-more-label">Show {item.showMoreCount} more blocks</span>
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
                    searchTerm={debouncedSearchTerm}
                  />
                );
              })}
            </div>
          )}
          
          {/* Properties section */}
          {propertyItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">
                Properties
              </div>
              {propertyItems.map((item) => {
                const globalIndex = indexMap.get(item)!;
                if (item.type === 'show-more') {
                  return (
                    <button
                      key="show-more-properties"
                      className={`command-palette__result command-palette__result--show-more ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <span className="command-palette__show-more-label">Show {item.showMoreCount} more properties</span>
                    </button>
                  );
                }
                return (
                  <ResultItem
                    key={item.result?.property?.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                    searchTerm={debouncedSearchTerm}
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

