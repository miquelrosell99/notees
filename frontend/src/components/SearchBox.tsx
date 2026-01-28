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
}

export function SearchBox<T = Node>({
  placeholder = 'Search...',
  className = '',
  onSelect,
  searchFn,
  getKey,
  renderItem,
  filterFn,
}: SearchBoxProps<T>) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
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
  const results = (filterFn && rawResults) ? (rawResults as T[]).filter(filterFn) : rawResults;
  
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

  const handleSelect = useCallback((item: T) => {
    setQuery('');
    setIsOpen(false);
    
    if (onSelect) {
      onSelect(item);
    } else {
      // Default behavior for Node type - navigate to the node
      const node = item as unknown as Node;
      if ('id' in node && 'is_page' in node) {
        openNode(node.id, node.is_page ? 'page' : 'block');
      }
    }
  }, [onSelect, openNode]);
  
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
    if (e.key === 'Escape') {
      setQuery('');
      setIsOpen(false);
      inputRef.current?.blur();
    }
  }, []);

  return (
    <div ref={containerRef} className={`search-box ${className}`}>
      <TextField
        ref={inputRef}
        type="search"
        className="search-input"
        value={query}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (query.length > 0) {
            updateDropdownPosition();
            setIsOpen(true);
          }
        }}
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
          
          {!isLoading && results && results.length === 0 && (
            <div className="search-empty">No results found</div>
          )}
          
          {!isLoading && results && results.length > 0 && (
            <ul className="search-results">
              {(results as T[]).map((item: T) => (
                <li key={getKey ? getKey(item) : defaultGetKey(item)}>
                  <button
                    className="search-result-item"
                    onClick={() => handleSelect(item)}
                  >
                    {renderItem ? renderItem(item) : defaultRenderItem(item)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
