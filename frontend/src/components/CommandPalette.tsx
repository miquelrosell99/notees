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
import { useSearch, useCreateNode, useTodayNote, usePages, usePageClass, useHierarchicalPath, useClassClass } from '@/hooks';
import { listNodes } from '@/api/nodes';
import { useNodesStore, useSettingsStore } from '@/stores';
import type { Node } from '@/types';
import { NodeIcon, BulletIcon, AddIcon } from './icons';
import { parseHierarchicalPath, resolveHierarchicalParent } from '@/utils/hierarchicalPath';
import { SuggestionPopup } from './SuggestionPopup';
import { NodeClassPill } from './NodeClassPill';

export interface CommandPaletteProps {
  /** Whether the palette is open */
  isOpen: boolean;
  /** Callback to close the palette */
  onClose: () => void;
  /** Callback when a node is selected */
  onSelect?: (node: Node) => void;
}

interface SearchResult {
  node: Node;
  type: 'page' | 'block';
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
      parts.unshift(parent.name || 'Untitled');
      current = parent;
    } else {
      break;
    }
  }
  
  // If node has a page_id different from parent, add page name
  if (node.page_id && node.page_id !== node.parent_id) {
    const page = allNodes.find(n => n.id === node.page_id);
    if (page && !parts.includes(page.name || 'Untitled')) {
      parts.unshift(page.name || 'Untitled');
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
 * Categorize search results into pages and blocks
 */
function categorizeResults(nodes: Node[]): { pages: SearchResult[]; blocks: SearchResult[] } {
  const pages: SearchResult[] = [];
  const blocks: SearchResult[] = [];
  
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
  
  return { pages, blocks };
}

/**
 * Result item component
 */
function ResultItem({
  result,
  isSelected,
  onClick,
}: {
  result: SearchResult;
  isSelected: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  
  // Scroll into view when selected
  useEffect(() => {
    if (isSelected && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);
  
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
          {result.node.name || 'Untitled'}
        </span>
        {result.breadcrumb && (
          <span className="command-palette__result-breadcrumb">
            {result.breadcrumb}
          </span>
        )}
      </span>
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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedClasses, setSelectedClasses] = useState<Node[]>([]);
  const [classPopupPosition, setClassPopupPosition] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { openNode } = useNodesStore();
  const { quickAddDestination } = useSettingsStore();
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();
  
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
  const inboxPage = allPages?.find(p => p.name === 'Inbox');
  const destinationPage = quickAddDestination === 'today' ? todayNote : inboxPage;
  
  // Categorize results
  const { pages, blocks } = useMemo(() => {
    if (!searchResults) return { pages: [], blocks: [] };
    return categorizeResults(searchResults);
  }, [searchResults]);
  
  // Analyze hierarchical path structure (use searchTerm without the @class part)
  const pathInfo = useHierarchicalPath(searchTerm, true);
  
  // Display name for page creation (without @class suffix)
  const pageNameForCreation = searchTerm.trim();
  
  // All selectable items (pages, blocks, quick-add actions)
  const allItems = useMemo(() => {
    const items: Array<{ type: 'page' | 'block' | 'add-page' | 'quick-add'; result?: SearchResult; label?: string }> = [];
    
    // Pages section
    pages.forEach(result => items.push({ type: 'page', result }));
    
    // Add page option if query exists and no exact match
    const classLabels = selectedClasses.length > 0 
      ? ` with ${selectedClasses.length === 1 ? `class "${selectedClasses[0].name}"` : `${selectedClasses.length} classes`}`
      : '';
    if (pageNameForCreation && !pages.some(p => p.node.name?.toLowerCase() === pageNameForCreation.toLowerCase())) {
      items.push({ type: 'add-page', label: `Create page "${pageNameForCreation}"${classLabels}` });
    }
    
    // Blocks section
    blocks.forEach(result => items.push({ type: 'block', result }));
    
    // Quick add option
    if (searchTerm.trim()) {
      items.push({ type: 'quick-add', label: `Quick add: "${searchTerm}"` });
    }
    
    return items;
  }, [pages, blocks, searchTerm, pageNameForCreation, selectedClasses]);
  
  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [allItems.length]);
  
  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
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
      case 'page':
      case 'block':
        if (item.result) {
          if (onSelect) {
            onSelect(item.result.node);
          } else {
            openNode(item.result.node.id, item.type === 'page' ? 'page' : 'block');
          }
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
          const newNode = await createNodeMutation.mutateAsync({
            name: parsed.leaf || pageNameForCreation,
            parent_id: parentId,
            classes,
          });
          onClose();
          openNode(newNode.id, 'page');
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
    }
  }, [allItems, searchTerm, pageNameForCreation, selectedClasses, pageClassId, destinationPage, onSelect, openNode, createNodeMutation, onClose]);
  
  // Handle keyboard navigation (only when class popup is not open)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Let SuggestionPopup handle keyboard when it's open
    if (isTypingClass) {
      // Only handle Escape to close command palette
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      return;
    }
    
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, allItems.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        handleSelect(selectedIndex);
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [allItems.length, selectedIndex, onClose, handleSelect, isTypingClass]);
  
  // Close on backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }, [onClose]);
  
  if (!isOpen) return null;
  
  // Group items for rendering
  const pageItems = allItems.filter(i => i.type === 'page' || i.type === 'add-page');
  const blockItems = allItems.filter(i => i.type === 'block');
  const quickAddItems = allItems.filter(i => i.type === 'quick-add');
  
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
            placeholder="Search pages and blocks..."
          />
          {/* Class pills */}
          {selectedClasses.length > 0 && (
            <div className="command-palette__class-pills">
              {selectedClasses.map(classNode => (
                <NodeClassPill
                  key={classNode.id}
                  classNode={classNode}
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
                  Start typing to search pages and blocks
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
                    key={item.result?.node.id}
                    result={item.result!}
                    isSelected={selectedIndex === globalIndex}
                    onClick={() => handleSelect(globalIndex)}
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
                    key={item.result?.node.id}
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
    </div>
  );
}

export default CommandPalette;
