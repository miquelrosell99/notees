/**
 * Search box component with live search
 * 
 * NOTE: Moved out of core/ - has domain knowledge (Node type, useSearch hook)
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useSearch } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import { NodeIcon, SearchIcon } from './icons';
import './SearchBox.css';

interface SearchBoxProps {
  placeholder?: string;
  className?: string;
  onSelect?: (node: Node) => void;
}

export function SearchBox({
  placeholder = 'Search...',
  className = '',
  onSelect,
}: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { openNode } = useNodesStore();
  const { data: results, isLoading } = useSearch(query);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as HTMLElement)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    setIsOpen(value.length > 0);
  }, []);

  const handleSelect = useCallback((node: Node) => {
    setQuery('');
    setIsOpen(false);
    
    if (onSelect) {
      onSelect(node);
    } else {
      // Navigate to the node
      openNode(node.id, node.is_page ? 'page' : 'block');
    }
  }, [onSelect, openNode]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setQuery('');
      setIsOpen(false);
      inputRef.current?.blur();
    }
  }, []);

  return (
    <div ref={containerRef} className={`search-box ${className}`}>
      <div className="search-box-input-wrapper">
        <input
          ref={inputRef}
          type="search"
          className="search-input"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => query.length > 0 && setIsOpen(true)}
          placeholder={placeholder}
        />
        <span className="search-box-icon">
          <SearchIcon size="sm" />
        </span>
      </div>
      
      {isOpen && (
        <div className="search-dropdown">
          {isLoading && (
            <div className="search-loading">Searching...</div>
          )}
          
          {!isLoading && results && results.length === 0 && (
            <div className="search-empty">No results found</div>
          )}
          
          {!isLoading && results && results.length > 0 && (
            <ul className="search-results">
              {results.map((node: Node) => (
                <li key={node.id}>
                  <button
                    className="search-result-item"
                    onClick={() => handleSelect(node)}
                  >
                    <span className="result-icon">
                      <NodeIcon icon={node.icon} isPage={true} />
                    </span>
                    <span className="result-title">
                      {node.name || 'Untitled'}
                    </span>
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
