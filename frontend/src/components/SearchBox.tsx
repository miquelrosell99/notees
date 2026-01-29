/**
 * Search box component with live search
 * 
 * Generic search component that can search different data types (nodes, properties, etc.)
 * by accepting custom search functions and renderers.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import { NodeIcon, SearchIcon } from './icons';
import { TextField } from './core/TextField';
import './SearchBox.css';

interface SearchSection<T = Node> {
  /** Section title/header */
  title?: string;
  /** Custom search function for this section */
  searchFn?: (query: string) => Promise<T[]> | T[];
  /** Filter function to apply to results in this section */
  filterFn?: (item: T) => boolean;
  /** Custom renderer for items in this section */
  renderItem?: (item: T) => React.ReactNode;
  /** Custom key extractor for items in this section */
  getKey?: (item: T) => string | number;
}

interface SearchBoxProps<T = Node> {
  placeholder?: string;
  className?: string;
  onSelect?: (item: T) => void;
  /** Custom search function that returns items matching the query */
  searchFn?: (query: string) => Promise<T[]> | T[];
  /** Custom key extractor for list items */
  getKey?: (item: T) => string | number;
  /** Custom renderer for each result item */
  renderItem?: (item: T) => React.ReactNode;
  /** Filter function to apply to results */
  filterFn?: (item: T) => boolean;
  /** Initial query value */
  initialQuery?: string;
  /** Auto-focus the input on mount */
  autoFocus?: boolean;
  /** Show create option for new items (Node search only) */
  showCreate?: boolean;
  /** Callback when create is selected (passes the query string) */
  onCreate?: (query: string) => void | Promise<void>;
  /** Multiple sections with separate queries/filters */
  sections?: SearchSection<T>[];
}

export function SearchBox<T = Node>({
  placeholder = 'Search...',
  className = '',
  onSelect,
  searchFn,
  getKey,
  renderItem,
  filterFn,
  initialQuery = '',
  autoFocus = false,
  showCreate = false,
  onCreate,
  sections,
}: SearchBoxProps<T>) {
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  const { openNode } = useNodesStore();
  
  // Debounce the query to avoid flashing results
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, 300);
    
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [query]);
  
  // Multi-section mode: run queries for each section
  const sectionQueries = (sections || []).map((section, index) => {
    const sectionSearchFn = section.searchFn;
    return useQuery({
      queryKey: ['section-search', index, debouncedQuery],
      queryFn: () => sectionSearchFn!(debouncedQuery),
      enabled: !!sectionSearchFn && debouncedQuery.length > 0,
    });
  });
  
  // Single-section mode: use custom search function or default to node search
  const defaultSearch = useSearch(debouncedQuery);
  const customSearch = useQuery({
    queryKey: ['custom-search', debouncedQuery],
    queryFn: () => searchFn!(debouncedQuery),
    enabled: !!searchFn && debouncedQuery.length > 0,
  });
  
  const searchResults = searchFn ? customSearch : defaultSearch;
  const { data: rawResults, isLoading: singleLoading } = searchResults;
  
  // Compute results based on mode (single vs multi-section)
  const isMultiSection = sections && sections.length > 0;
  
  let allSections: Array<{ title?: string; items: T[] }> = [];
  let isLoading = false;
  let totalItems = 0;
  
  if (isMultiSection) {
    // Multi-section mode
    isLoading = sectionQueries.some(q => q.isLoading);
    allSections = sections!.map((section, index) => {
      const query = sectionQueries[index];
      const rawItems = query.data || [];
      const items = section.filterFn ? (rawItems as T[]).filter(section.filterFn) : (rawItems as T[]);
      return { title: section.title, items };
    });
    totalItems = allSections.reduce((sum, s) => sum + s.items.length, 0);
  } else {
    // Single-section mode
    isLoading = singleLoading;
    const filteredResults = (filterFn && rawResults) ? (rawResults as T[]).filter(filterFn) : rawResults;
    const results = (filteredResults || []) as T[];
    allSections = [{ items: results }];
    totalItems = results.length;
  }
  
  // Add create option if enabled and query exists
  const showCreateOption = showCreate && query.trim().length > 0 && !isLoading;
  if (showCreateOption) {
    totalItems += 1;
  }
  
  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [totalItems]);
  
  // Auto-focus if requested
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);
  
  // Update dropdown position when opening
  const updateDropdownPosition = useCallback(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width
      });
    }
  }, []);

  // Close dropdown when clicking outside and update position on scroll
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as HTMLElement)) {
        setIsOpen(false);
      }
    };
    
    const handleScroll = () => {
      if (isOpen) {
        updateDropdownPosition();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, updateDropdownPosition]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    if (value.length > 0) {
      updateDropdownPosition();
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  }, [updateDropdownPosition]);

  const handleSelect = useCallback((item: T | 'create') => {
    setQuery('');
    setIsOpen(false);
    
    if (item === 'create') {
      if (onCreate) {
        onCreate(query);
      }
      return;
    }
    
    if (onSelect) {
      onSelect(item);
    } else {
      // Default behavior for Node type - navigate to the node
      const node = item as unknown as Node;
      if ('id' in node && 'is_page' in node) {
        openNode(node.id, node.is_page ? 'page' : 'block');
      }
    }
  }, [onSelect, openNode, onCreate, query]);
  
  // Default key extractor
  const defaultGetKey = (item: T): string | number => {
    if (typeof item === 'object' && item !== null && 'id' in item) {
      return (item as any).id;
    }
    return Math.random();
  };
  
  // Default renderer for Node type
  const defaultRenderItem = (item: T): React.ReactNode => {
    const node = item as unknown as Node;
    if ('name' in node) {
      return (
        <>
          <span className="result-icon">
            <NodeIcon icon={node.icon} isPage={true} />
          </span>
          <span className="result-title">
            {node.name || 'Untitled'}
          </span>
        </>
      );
    }
    return <span>{String(item)}</span>;
  };
  
  // Helper: get item by flat index (accounting for create option and sections)
  const getItemByIndex = useCallback((flatIndex: number): T | 'create' | null => {
    if (showCreateOption && flatIndex === 0) {
      return 'create';
    }
    
    let adjustedIndex = showCreateOption ? flatIndex - 1 : flatIndex;
    
    for (const section of allSections) {
      if (adjustedIndex < section.items.length) {
        return section.items[adjustedIndex];
      }
      adjustedIndex -= section.items.length;
    }
    
    return null;
  }, [showCreateOption, allSections]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen) return;
    
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, totalItems - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (totalItems > 0) {
          const item = getItemByIndex(selectedIndex);
          if (item) {
            handleSelect(item as T);
          }
        }
        break;
      case 'Escape':
        setQuery('');
        setIsOpen(false);
        inputRef.current?.blur();
        break;
    }
  }, [isOpen, totalItems, showCreateOption, selectedIndex, getItemByIndex, handleSelect]);

  const handleResultClick = useCallback((index: number) => {
    const item = getItemByIndex(index);
    if (item) {
      handleSelect(item as T);
    }
  }, [getItemByIndex, handleSelect]);

  return (
    <div ref={containerRef} className={`search-box ${className}`}>
      <TextField
        ref={inputRef}
        value={query}
        onChange={handleInputChange}
        onFocus={() => {
          if (query.length > 0) {
            updateDropdownPosition();
            setIsOpen(true);
          }
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        icon={<SearchIcon size="sm" />}
      />
      
      {isOpen && (
        <div 
          className="search-dropdown search-dropdown--fixed"
          style={{
            position: 'fixed',
            top: `${dropdownPosition.top}px`,
            left: `${dropdownPosition.left}px`,
            width: `${dropdownPosition.width}px`
          }}
        >
          {isLoading && (
            <div className="search-loading">Searching...</div>
          )}
          
          {!isLoading && totalItems === 0 && (
            <div className="search-empty">No results found</div>
          )}
          
          {!isLoading && totalItems > 0 && (
            <ul className="search-results">
              {showCreateOption && (
                <li key="create">
                  <button
                    className={`search-result-item search-result-item--create ${selectedIndex === 0 ? 'search-result-item--selected' : ''}`}
                    onClick={() => handleResultClick(0)}
                    onMouseEnter={() => setSelectedIndex(0)}
                  >
                    <span className="result-icon">+</span>
                    <span className="result-title">Create "{query}"</span>
                  </button>
                </li>
              )}
              {allSections.map((section, sectionIndex) => {
                if (section.items.length === 0) return null;
                
                // Calculate flat index offset for this section
                let flatIndexOffset = showCreateOption ? 1 : 0;
                for (let i = 0; i < sectionIndex; i++) {
                  flatIndexOffset += allSections[i].items.length;
                }
                
                const sectionConfig = isMultiSection ? sections![sectionIndex] : undefined;
                const sectionGetKey = sectionConfig?.getKey || getKey || defaultGetKey;
                const sectionRenderItem = sectionConfig?.renderItem || renderItem || defaultRenderItem;
                
                return (
                  <div key={`section-${sectionIndex}`}>
                    {section.title && (
                      <li className="search-section-header">
                        {section.title}
                      </li>
                    )}
                    {section.items.map((item, itemIndex) => {
                      const flatIndex = flatIndexOffset + itemIndex;
                      return (
                        <li key={sectionGetKey(item)}>
                          <button
                            className={`search-result-item ${selectedIndex === flatIndex ? 'search-result-item--selected' : ''}`}
                            onClick={() => handleResultClick(flatIndex)}
                            onMouseEnter={() => setSelectedIndex(flatIndex)}
                          >
                            {sectionRenderItem(item)}
                          </button>
                        </li>
                      );
                    })}
                  </div>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
