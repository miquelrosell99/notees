/**
 * NodePicker - Component for selecting nodes in property values
 * 
 * For node-type properties:
 * - Pages are always included by default
 * - Additional node types can be included via tag_filters on the property
 * - Shows a searchable dropdown with matching nodes
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useNodeSearch, usePages, useNodes } from '@/hooks';
import type { Node, Property } from '@/types/api';
import { NodeIcon, AddIcon, BulletIcon, CheckIcon } from '../icons';
import { Button } from '../core/Button';
import './NodePicker.css';

interface NodePickerProps {
  /** The property definition (for tag_filters) */
  property: Property;
  /** Currently selected node ID(s) */
  value: number | number[] | null;
  /** Whether multi-select is enabled */
  multi?: boolean;
  /** Whether the picker is read-only */
  readOnly?: boolean;
  /** Callback when selection changes */
  onChange: (value: number | number[] | null) => void;
  /** Callback to navigate to a node */
  onNavigate?: (nodeId: number) => void;
  /** Callback to create a new page */
  onCreate?: (name: string) => Promise<Node>;
}

interface SelectedNode {
  id: number;
  name: string;
  icon: string | null;
  isPage: boolean;
}

/**
 * NodePicker Component
 */
export function NodePicker({
  property,
  value,
  multi = false,
  readOnly = false,
  onChange,
  onNavigate,
  onCreate,
}: NodePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Fetch data for selected node lookup
  const { data: allPages } = usePages();
  const { data: allNodes } = useNodes();
  
  // Use shared search hook with tag filters from property
  const { allResults, isLoading, showCreateOption: searchShowCreate } = useNodeSearch(query, {
    mode: 'all',
    tagFilters: property.tag_filters ?? [],
    maxResults: 15,
  });
  
  // Convert search results to Node array
  const filteredResults = useMemo(() => allResults.map(r => r.node), [allResults]);
  
  // Only show create option if onCreate is provided
  const showCreateOption = searchShowCreate && !!onCreate;
  
  // Get selected node details
  const selectedNodes = useMemo((): SelectedNode[] => {
    if (!value) return [];
    const ids = Array.isArray(value) ? value : [value];
    const nodes: SelectedNode[] = [];
    
    for (const id of ids) {
      const node = allNodes?.find(n => n.id === id) || allPages?.find(n => n.id === id);
      if (node) {
        nodes.push({
          id: node.id,
          name: node.name || 'Untitled',
          icon: node.icon,
          isPage: node.parent_id === null,
        });
      } else {
        // Fallback if node not found
        nodes.push({
          id,
          name: `Node #${id}`,
          icon: null,
          isPage: true,
        });
      }
    }
    
    return nodes;
  }, [value, allNodes, allPages]);
  
  const totalItems = filteredResults.length + (showCreateOption ? 1 : 0);
  
  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredResults.length, query]);
  
  // Handle node selection
  const handleSelect = useCallback((node: Node) => {
    if (multi) {
      const currentIds = Array.isArray(value) ? value : value ? [value] : [];
      if (currentIds.includes(node.id)) {
        // Remove if already selected
        onChange(currentIds.filter(id => id !== node.id));
      } else {
        // Add to selection
        onChange([...currentIds, node.id]);
      }
    } else {
      onChange(node.id);
      setIsOpen(false);
      setQuery('');
    }
  }, [multi, value, onChange]);
  
  // Handle creating a new page
  const handleCreate = useCallback(async () => {
    if (!onCreate || !query.trim()) return;
    
    try {
      const newNode = await onCreate(query.trim());
      handleSelect(newNode);
    } catch (error) {
      console.error('Failed to create node:', error);
    }
  }, [onCreate, query, handleSelect]);
  
  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }
    
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
        if (selectedIndex < filteredResults.length) {
          handleSelect(filteredResults[selectedIndex]);
        } else if (showCreateOption) {
          handleCreate();
        }
        break;
        
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setQuery('');
        break;
    }
  }, [isOpen, selectedIndex, totalItems, filteredResults, showCreateOption, onCreate, handleCreate, handleSelect]);
  
  // Handle removing a selected node
  const handleRemove = useCallback((nodeId: number) => {
    if (multi) {
      const currentIds = Array.isArray(value) ? value : value ? [value] : [];
      onChange(currentIds.filter(id => id !== nodeId));
    } else {
      onChange(null);
    }
  }, [multi, value, onChange]);
  
  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        setIsOpen(false);
        setQuery('');
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);
  
  // Focus input when opening
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);
  
  if (readOnly) {
    return (
      <div className="node-picker node-picker--readonly">
        {selectedNodes.length > 0 ? (
          <div className="node-picker__selected-list">
            {selectedNodes.map(node => (
              <button
                key={node.id}
                className="node-picker__chip node-picker__chip--readonly"
                onClick={() => onNavigate?.(node.id)}
              >
                {node.isPage ? (
                  <NodeIcon icon={node.icon} isPage={true} size="xs" />
                ) : (
                  <BulletIcon size="xs" />
                )}
                <span>{node.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <span className="node-picker__placeholder">—</span>
        )}
      </div>
    );
  }
  
  return (
    <div className="node-picker" ref={containerRef}>
      {/* Selected nodes display */}
      <div className="node-picker__selected">
        {selectedNodes.map(node => (
          <span key={node.id} className="node-picker__chip">
            {node.isPage ? (
              <NodeIcon icon={node.icon} isPage={true} size="xs" />
            ) : (
              <BulletIcon size="xs" />
            )}
            <Button 
              variant="ghost"
              size="xs"
              className="node-picker__chip-name"
              onClick={() => onNavigate?.(node.id)}
            >
              {node.name}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="node-picker__chip-remove"
              onClick={() => handleRemove(node.id)}
              aria-label={`Remove ${node.name}`}
            >
              ×
            </Button>
          </span>
        ))}
        
        {/* Input trigger */}
        <Button
          variant="ghost"
          size="xs"
          className="node-picker__trigger"
          onClick={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
        >
          {selectedNodes.length === 0 && (
            <span className="node-picker__placeholder">Select...</span>
          )}
          {multi && selectedNodes.length > 0 && (
            <span className="node-picker__add-more">+</span>
          )}
        </Button>
      </div>
      
      {/* Dropdown */}
      {isOpen && (
        <div className="node-picker__dropdown">
          <input
            ref={inputRef}
            type="text"
            className="node-picker__search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages..."
          />
          
          <div className="node-picker__list">
            {isLoading && query.length > 0 ? (
              <div className="node-picker__loading">Searching...</div>
            ) : filteredResults.length === 0 && !showCreateOption ? (
              <div className="node-picker__empty">
                {query ? 'No matches found' : 'Start typing to search'}
              </div>
            ) : (
              <>
                {filteredResults.map((node, index) => {
                  const isSelected = Array.isArray(value) 
                    ? value.includes(node.id) 
                    : value === node.id;
                  const isPage = node.parent_id === null;
                  
                  return (
                    <button
                      key={node.id}
                      className={`node-picker__item ${index === selectedIndex ? 'node-picker__item--highlighted' : ''} ${isSelected ? 'node-picker__item--selected' : ''}`}
                      onClick={() => handleSelect(node)}
                      onMouseEnter={() => setSelectedIndex(index)}
                    >
                      <span className="node-picker__item-icon">
                        {isPage ? (
                          <NodeIcon icon={node.icon} isPage={true} size="sm" />
                        ) : (
                          <BulletIcon size="sm" />
                        )}
                      </span>
                      <span className="node-picker__item-name">
                        {node.name || 'Untitled'}
                      </span>
                      {isSelected && (
                        <span className="node-picker__item-check"><CheckIcon size="xs" /></span>
                      )}
                    </button>
                  );
                })}
                
                {showCreateOption && (
                  <button
                    className={`node-picker__item node-picker__item--create ${
                      selectedIndex === filteredResults.length ? 'node-picker__item--highlighted' : ''
                    }`}
                    onClick={handleCreate}
                    onMouseEnter={() => setSelectedIndex(filteredResults.length)}
                  >
                    <span className="node-picker__item-icon">
                      <AddIcon size="sm" />
                    </span>
                    <span className="node-picker__item-name">
                      Create "{query.trim()}"
                    </span>
                  </button>
                )}
              </>
            )}
          </div>
          
          <div className="node-picker__footer">
            <span className="node-picker__hint">
              Pages only{property.tag_filters?.length ? ' + filtered types' : ''}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default NodePicker;
