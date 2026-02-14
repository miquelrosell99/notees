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
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import './CommandPalette.css';
import { useSearch, useCreateNode, useTodayNote, usePages, usePageClass, useHierarchicalPath, useClassClass, useProperties } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import { listNodes, getOrCreateDaily, getOrCreateMonthly, getOrCreateYearly } from '@/api/nodes';
import { useAppStore, useSettingsStore } from '@/stores';
import type { Node, Property } from '@/types';
import { NodeIcon, BulletIcon, AddIcon, PropertiesIcon, CalendarIcon, ImportIcon } from '../core/icons';
import Icon from '@mdi/react';
import { mdiExport } from '@mdi/js';
import { parseHierarchicalPath, resolveHierarchicalParent } from '@/utils/hierarchicalPath';
import { SuggestionPopup } from '../nodes/SuggestionPopup';
import { NodePill } from '../nodes/NodePill';
import { DuplicatePageModal } from './DuplicatePageModal';
import { parseDate, generateDateUuid, type ParsedDate } from '@/utils/dateParser';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';

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
 * Build breadcrumb from node hierarchy
 */
function buildBreadcrumb(node: Node, allNodes: Node[]): string {
  const parts: string[] = [];
  let current: Node | undefined = node;
  
  // Walk up the parent chain
  while (current?.parent_id) {
    const parent = allNodes.find(n => n.id === current?.parent_id);
    if (parent) {
      parts.unshift(nodeNameToText(parent.name) || 'Untitled');
      current = parent;
    } else {
      break;
    }
  }
  
  // If node has a page_id different from parent, add page name
  if (node.page_id && node.page_id !== node.parent_id) {
    const page = allNodes.find(n => n.id === node.page_id);
    if (page) {
      const pageName = nodeNameToText(page.name) || 'Untitled';
      if (!parts.includes(pageName)) {
        parts.unshift(pageName);
      }
    }
  }
  
  return parts.join(' > ');
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

/**
 * Categorize search results into pages, blocks, and properties
 */
function categorizeResults(
  nodes: Node[], 
  properties: Property[], 
  query: string
): { pages: SearchResult[]; blocks: SearchResult[]; properties: SearchResult[] } {
  const pages: SearchResult[] = [];
  const blocks: SearchResult[] = [];
  const propertiesResults: SearchResult[] = [];
  
  for (const node of nodes) {
    const isPage = node.parent_id === null;
    const breadcrumb = isPage ? undefined : buildBreadcrumb(node, nodes);
    
    const result: SearchResult = { node, type: isPage ? 'page' : 'block', breadcrumb };
    
    if (isPage) {
      pages.push(result);
    } else {
      blocks.push(result);
    }
  }
  
  // Filter properties by query
  if (query.trim()) {
    const lowerQuery = query.toLowerCase();
    for (const property of properties) {
      if (property.name.toLowerCase().includes(lowerQuery)) {
        propertiesResults.push({ property, type: 'property' });
      }
    }
  }
  
  return { pages, blocks, properties: propertiesResults };
}

/**
 * Result item component
 */
function ResultItem({
  result,
  isSelected,
  onClick,
  allNodes,
}: {
  result: SearchResult;
  isSelected: boolean;
  onClick: () => void;
  allNodes?: Node[];
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
      </button>
    );
  }
  
  // Handle node results
  if (!result.node) return null;
  
  return (
    <button
      ref={ref}
      className={`command-palette__result ${isSelected ? 'command-palette__result--selected' : ''}`}
      onClick={onClick}
    >
      <span className="command-palette__result-icon">
        {result.type === 'page' ? (
          <NodeIcon icon={result.node.icon} isPage={true} size="sm" />
        ) : (
          <BulletIcon size="xs" />
        )}
      </span>
      <span className="command-palette__result-content">
        <span className="command-palette__result-name">
          {nodeNameToText(result.node.name) || 'Untitled'}
        </span>
        {result.breadcrumb && (
          <span className="command-palette__result-breadcrumb">
            {result.breadcrumb}
          </span>
        )}
      </span>
      {aliasedNodeName && (
        <span className="command-palette__result-alias">
          alias of: {aliasedNodeName}
        </span>
      )}
      <span className="command-palette__result-type">
        {result.type}
      </span>
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
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { openNode, openPropertyView } = useAppStore();
  const { quickAddDestination } = useSettingsStore();
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();
  
  // Fetch all properties for search
  const { data: allProperties = [] } = useProperties();
  
  // Parse query for @classname syntax
  const { searchTerm, isTypingClass, classQuery } = useMemo(() => parseQueryWithClass(query), [query]);
  
  // Build class filter for search from selected classes
  const classFilter = selectedClasses.length > 0 
    ? selectedClasses.map(c => c.id).join(',')
    : undefined;
  
  // Search with optional class filter (only search when not typing class)
  const { data: searchResults, isLoading } = useSearch(
    isTypingClass ? '' : searchTerm, 
    classFilter
  );
  
  // Get destination page for quick add
  const { data: todayNote } = useTodayNote();
  const { data: allPages } = usePages({ includeChildren: true });
  const inboxPage = allPages?.find(p => nodeNameToText(p.name) === 'Inbox');
  const destinationPage = quickAddDestination === 'today' ? todayNote : inboxPage;
  
  // Categorize results
  const { pages, blocks, properties } = useMemo(() => {
    if (!searchResults) return { pages: [], blocks: [], properties: [] };
    return categorizeResults(searchResults, allProperties, searchTerm);
  }, [searchResults, allProperties, searchTerm]);
  
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
  
  // All selectable items (pages, blocks, properties, quick-add actions)
  // Command definitions for the palette
  const commands = useMemo(() => {
    const cmds: Array<{ id: string; label: string; icon: 'import' | 'export'; requiresPage?: boolean }> = [
      { id: 'import-logseq', label: 'Import Logseq EDN', icon: 'import' },
      { id: 'import-markdown', label: 'Import Markdown files', icon: 'import' },
      { id: 'export-page', label: 'Export current page', icon: 'export', requiresPage: true },
    ];
    return cmds;
  }, []);

  const allItems = useMemo(() => {
    const items: Array<{ type: 'page' | 'block' | 'property' | 'add-page' | 'quick-add' | 'date' | 'command'; result?: SearchResult; label?: string; parsedDate?: ParsedDate; existingNode?: Node; commandId?: string; commandIcon?: 'import' | 'export' }> = [];
    
    // Date suggestion (shown at top if query matches a date format)
    if (parsedDate) {
      const dateTypeLabel = parsedDate.type === 'day' ? 'daily' : parsedDate.type === 'month' ? 'monthly' : 'yearly';
      if (existingDateNode) {
        items.push({ type: 'date', label: `Go to ${dateTypeLabel} page: ${nodeNameToText(existingDateNode.name) || parsedDate.label}`, parsedDate, existingNode: existingDateNode });
      } else {
        items.push({ type: 'date', label: `Create ${dateTypeLabel} page: ${parsedDate.label}`, parsedDate });
      }
    }
    
    // Pages section
    pages.forEach(result => items.push({ type: 'page', result }));
    
    // Add page option — always show when there's a name to create
    const classLabels = selectedClasses.length > 0 
      ? ` with ${selectedClasses.length === 1 ? `class "${nodeNameToText(selectedClasses[0].name)}"` : `${selectedClasses.length} classes`}`
      : '';
    const hasExactMatch = pages.some(p => nodeNameToText(p.node?.name)?.toLowerCase() === pageNameForCreation.toLowerCase());
    if (pageNameForCreation) {
      const label = hasExactMatch
        ? `Create another "${pageNameForCreation}"${classLabels || ' (pick a class to differentiate)'}`
        : `Create page "${pageNameForCreation}"${classLabels}`;
      items.push({ type: 'add-page', label });
    }
    
    // Blocks section
    blocks.forEach(result => items.push({ type: 'block', result }));
    
    // Properties section
    properties.forEach(result => items.push({ type: 'property', result }));
    
    // Quick add option
    if (searchTerm.trim()) {
      items.push({ type: 'quick-add', label: `Quick add: "${searchTerm}"` });
    }

    // Commands section — only show when user is searching
    if (searchTerm.trim()) {
      const lowerSearch = searchTerm.toLowerCase();
      for (const cmd of commands) {
        if (cmd.label.toLowerCase().includes(lowerSearch)) {
          items.push({ type: 'command', label: cmd.label, commandId: cmd.id, commandIcon: cmd.icon });
        }
      }
    }
    
    return items;
  }, [pages, blocks, properties, searchTerm, pageNameForCreation, selectedClasses, parsedDate, existingDateNode, commands]);
  
  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedClasses([]);
      setClassPopupPosition(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);
  
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
      console.error('Failed to create class:', error);
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
            queryClient.invalidateQueries({ queryKey: nodeKeys.pages() });
            queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
            queryClient.invalidateQueries({ queryKey: nodeKeys.dailyList() });
          }
          if (onSelect) {
            onSelect(dateNode);
          } else {
            openNode(dateNode.id);
          }
        } catch (error) {
          console.error('Failed to navigate to date page:', error);
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
            console.error('[CommandPalette] Page class not found');
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
              console.error('Failed to create page:', createErr);
            }
          }
        } catch (error) {
          console.error('Failed to create page:', error);
        }
        break;
        
      case 'quick-add':
        // Quick add as block (to daily page or inbox) with selected classes
        if (!destinationPage) {
          console.error('[CommandPalette] No destination page for quick add');
          break;
        }
        try {
          await createNodeMutation.mutateAsync({
            name: searchTerm.trim(),
            parent_id: destinationPage.id,
            classes: selectedClasses.map(c => c.id),
          });
        } catch (error) {
          console.error('Failed to quick add:', error);
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
  
  // Close on backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);
  
  if (!isOpen) return null;
  
  // Group items for rendering
  const dateItems = allItems.filter(i => i.type === 'date');
  const pageItems = allItems.filter(i => i.type === 'page' || i.type === 'add-page');
  const blockItems = allItems.filter(i => i.type === 'block');
  const propertyItems = allItems.filter(i => i.type === 'property');
  const quickAddItems = allItems.filter(i => i.type === 'quick-add');
  const commandItems = allItems.filter(i => i.type === 'command');
  
  return (
    <div className="command-palette__backdrop" onClick={handleBackdropClick}>
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
                <NodePill
                  key={classNode.id}
                  node={classNode}
                  onRemove={() => handleRemoveClass(classNode.id)}
                  readOnly={false}
                />
              ))}
            </div>
          )}
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
        
        {/* Hierarchical path preview */}
        {pathInfo && !isTypingClass && (
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
              {isLoading && (
                <div className="command-palette__loading">Searching...</div>
              )}
              
              {!isLoading && query && allItems.length === 0 && (
                <div className="command-palette__empty">No results found</div>
              )}
              
              {!isLoading && !query && (
                <div className="command-palette__hint">
                  Start typing to search pages, blocks, and properties
                </div>
              )}
              
              {/* Date suggestion section */}
              {dateItems.length > 0 && (
                <div className="command-palette__section">
                  <div className="command-palette__section-header">Date Pages</div>
                  {dateItems.map((item) => {
                    const globalIndex = allItems.indexOf(item);
                    return (
                      <button
                        key="date-page"
                        className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                        onClick={() => handleSelect(globalIndex)}
                      >
                        <span className="command-palette__result-icon">
                          <CalendarIcon size="sm" />
                        </span>
                        <span className="command-palette__result-content">
                          <span className="command-palette__result-name">{item.label}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              
              {/* Pages section */}
              {pageItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Pages</div>
              {pageItems.map((item) => {
                const globalIndex = allItems.indexOf(item);
                if (item.type === 'add-page') {
                  return (
                    <button
                      key="add-page"
                      className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                      onClick={() => handleSelect(globalIndex)}
                    >
                      <span className="command-palette__result-icon">
                        <AddIcon size="sm" />
                      </span>
                      <span className="command-palette__result-content">
                        <span className="command-palette__result-name">{item.label}</span>
                      </span>
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
                  />
                );
              })}
            </div>
          )}
          
          {/* Blocks section */}
          {blockItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Blocks</div>
              {blockItems.map((item) => {
                const globalIndex = allItems.indexOf(item);
                return (
                  <ResultItem
                    key={item.result?.node?.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
                    allNodes={searchResults}
                  />
                );
              })}
            </div>
          )}
          
          {/* Properties section */}
          {propertyItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Properties</div>
              {propertyItems.map((item) => {
                const globalIndex = allItems.indexOf(item);
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
                const globalIndex = allItems.indexOf(item);
                return (
                  <button
                    key="quick-add"
                    className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                    onClick={() => handleSelect(globalIndex)}
                  >
                    <span className="command-palette__result-icon">
                      <AddIcon size="sm" />
                    </span>
                    <span className="command-palette__result-content">
                      <span className="command-palette__result-name">{item.label}</span>
                    </span>
                    <kbd className="command-palette__item-shortcut">⌘↵</kbd>
                  </button>
                );
              })}
            </div>
          )}

          {/* Commands section */}
          {commandItems.length > 0 && (
            <div className="command-palette__section">
              <div className="command-palette__section-header">Commands</div>
              {commandItems.map((item) => {
                const globalIndex = allItems.indexOf(item);
                return (
                  <button
                    key={item.commandId}
                    className={`command-palette__result command-palette__result--action ${selectedIndex === globalIndex ? 'command-palette__result--selected' : ''}`}
                    onClick={() => handleSelect(globalIndex)}
                  >
                    <span className="command-palette__result-icon">
                      {item.commandIcon === 'import' ? (
                        <ImportIcon size="sm" />
                      ) : (
                        <Icon path={mdiExport} size={0.7} />
                      )}
                    </span>
                    <span className="command-palette__result-content">
                      <span className="command-palette__result-name">{item.label}</span>
                    </span>
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
  );
}

export default CommandPalette;
