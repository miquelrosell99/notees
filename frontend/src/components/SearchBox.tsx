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
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0, width: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const { openNode } = useNodesStore();
  const { data: results, isLoading } = useSearch(query);
  
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
          onFocus={() => {
            if (query.length > 0) {
              updateDropdownPosition();
              setIsOpen(true);
            }
          }}
          placeholder={placeholder}
        />
        <span className="search-box-icon">
          <SearchIcon size="sm" />
        </span>
      </div>
      
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
