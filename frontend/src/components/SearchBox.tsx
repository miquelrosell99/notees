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
}: SearchBoxProps<T>) {
  const [query, setQuery] = useState(initialQuery);
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { openNode } = useNodesStore();
  
  // Use custom search function or default to node search
  const defaultSearch = useSearch(query);
  const customSearch = useQuery({
    queryKey: ['custom-search', query],
    queryFn: () => searchFn!(query),
    enabled: !!searchFn && query.length > 0,
  });
  
  const searchResults = searchFn ? customSearch : defaultSearch;
  const { data: rawResults, isLoading } = searchResults;
  
  // Apply filter if provided
  const filteredResults = (filterFn && rawResults) ? (rawResults as T[]).filter(filterFn) : rawResults;
  const results = filteredResults || [];
  
  // Add create option if enabled and query exists
  const showCreateOption = showCreate && query.trim().length > 0 && !isLoading;
  const totalItems = results.length + (showCreateOption ? 1 : 0);
  
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
          if (showCreateOption && selectedIndex === 0) {
            handleSelect('create' as T);
          } else {
            const resultIndex = showCreateOption ? selectedIndex - 1 : selectedIndex;
            if (results && resultIndex >= 0 && resultIndex < results.length) {
              handleSelect(results[resultIndex] as T);
            }
          }
        }
        break;
      case 'Escape':
        setQuery('');
        setIsOpen(false);
        inputRef.current?.blur();
        break;
    }
  }, [isOpen, totalItems, showCreateOption, selectedIndex, results, handleSelect]);

  const handleResultClick = useCallback((index: number) => {
    if (showCreateOption && index === 0) {
      handleSelect('create' as T);
    } else {
      const resultIndex = showCreateOption ? index - 1 : index;
      if (results && resultIndex >= 0 && resultIndex < results.length) {
        handleSelect(results[resultIndex] as T);
      }
    }
  }, [showCreateOption, results, handleSelect]);

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
          
          {!isLoading && results.length === 0 && !showCreateOption && (
            <div className="search-empty">No results found</div>
          )}
          
          {!isLoading && (results.length > 0 || showCreateOption) && (
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
              {(results as T[]).map((item: T, index: number) => {
                const displayIndex = showCreateOption ? index + 1 : index;
                return (
                  <li key={getKey ? getKey(item) : defaultGetKey(item)}>
                    <button
                      className={`search-result-item ${selectedIndex === displayIndex ? 'search-result-item--selected' : ''}`}
                      onClick={() => handleResultClick(displayIndex)}
                      onMouseEnter={() => setSelectedIndex(displayIndex)}
                    >
                      {renderItem ? renderItem(item) : defaultRenderItem(item)}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
