/**
 * NodePicker - Component for selecting nodes in property values
 * 
 * For node-type properties:
 * - Pages are always included by default
 * - Additional node types can be included via class_filters on the property
 * - Shows a searchable dropdown with matching nodes
 * 
 * Enhanced with:
 * - Dropdown-like trigger with chevron icon
 * - Portal rendering for proper z-index layering
 * - Recent nodes shown when query is empty
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNodeSearch, usePages, useNodes } from '@/hooks';
import type { Node, Property } from '@/types/api';
import { NodeIcon, AddIcon, BulletIcon, CheckIcon } from '../icons';
import { Card } from '../core/Card';
import { SelectTrigger } from '../core/SelectTrigger';
import { NodePill } from '../NodePill';
import './NodePicker.css';

interface NodePickerProps {
  /** The property definition (for class_filters) */
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
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Fetch data for selected node lookup
  const { data: allPages } = usePages();
  const { data: allNodes } = useNodes();
  
  // Use shared search hook with class filters from property
  const { allResults, isLoading, showCreateOption: searchShowCreate } = useNodeSearch(query, {
    mode: 'all',
    classFilters: property.class_filters ?? [],
    maxResults: 15,
  });
  
  // When no query, show recent pages (up to 10) based on class filters
  const recentNodes = useMemo(() => {
    if (query || !allPages) return [];
    
    let nodes = allPages;
    
    // Filter by class if class_filters are specified
    if (property.class_filters && property.class_filters.length > 0) {
      nodes = nodes.filter(node => {
        const nodeClasses = node.classes || [];
        return property.class_filters!.some(filterId => nodeClasses.includes(filterId));
      });
    }
    
    // Return most recent 10
    return nodes.slice(0, 10);
  }, [query, allPages, property.class_filters]);
  
  // Convert search results to Node array, or use recent nodes when no query
  const filteredResults = useMemo(() => {
    if (query) {
      return allResults.map(r => r.node);
    }
    return recentNodes;
  }, [query, allResults, recentNodes]);
  
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
  
  // Update menu position when opened (for portal)
  useEffect(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom;
      const spaceAbove = rect.top;
      const maxDropdownHeight = 320;
      const gap = 4;
      
      // Determine if dropdown should open above or below
      let top: number;
      let maxHeight: number;
      
      if (spaceBelow >= maxDropdownHeight || spaceBelow > spaceAbove) {
        // Open below
        top = rect.bottom + window.scrollY + gap;
        maxHeight = Math.min(maxDropdownHeight, spaceBelow - gap * 2);
      } else {
        // Open above
        maxHeight = Math.min(maxDropdownHeight, spaceAbove - gap * 2);
        top = rect.top + window.scrollY - maxHeight - gap;
      }
      
      setMenuPosition({
        top,
        left: rect.left + window.scrollX,
        width: Math.max(rect.width, 240),
        maxHeight,
      });
    } else {
      setMenuPosition(null);
    }
  }, [isOpen]);
  
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

  // Handle clearing all selections
  const handleClearAll = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (multi) {
      onChange([]);
    } else {
      onChange(null);
    }
    setIsOpen(false);
  }, [multi, onChange]);
  
  // Close on click outside (handle both container and portaled menu)
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as globalThis.Node;
      // Check if click is outside both container and menu
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        menuRef.current &&
        !menuRef.current.contains(target)
      ) {
        setIsOpen(false);
        setQuery('');
      }
    };
    
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setQuery('');
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
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
      {/* Trigger - Using common SelectTrigger */}
      <SelectTrigger
        isOpen={isOpen}
        disabled={readOnly}
        clearable={!readOnly}
        hasValue={selectedNodes.length > 0}
        onClick={() => !readOnly && setIsOpen(prev => !prev)}
        onClear={readOnly ? undefined : handleClearAll}
      >
        {/* Display selected value(s) */}
        {selectedNodes.length > 0 ? (
          multi ? (
            // Multi-select: Show NodePills with remove buttons
            <div className="node-picker__selected-pills">
              {selectedNodes.map(node => (
                <NodePill
                  key={node.id}
                  nodeId={node.id}
                  onClick={() => onNavigate?.(node.id)}
                  onRemove={readOnly ? undefined : () => handleRemove(node.id)}
                  readOnly={readOnly}
                />
              ))}
            </div>
          ) : (
            // Single-select: Just show the node name (clear via SelectTrigger button)
            <span className="node-picker__single-value">
              {selectedNodes[0].name}
            </span>
          )
        ) : (
          <span className="node-picker__placeholder">Select node...</span>
        )}
      </SelectTrigger>
      
      {/* Dropdown Menu - Rendered in Portal */}
      {isOpen && menuPosition && createPortal(
        <Card
          ref={menuRef}
          className="node-picker__dropdown node-picker__dropdown--portal"
          elevation="high"
          padding={false}
          style={{
            position: 'absolute',
            top: `${menuPosition.top}px`,
            left: `${menuPosition.left}px`,
            minWidth: `${menuPosition.width}px`,
            maxHeight: `${menuPosition.maxHeight}px`,
          }}
        >
          {/* Search Input */}
          <div className="node-picker__search-wrapper">
            <input
              ref={inputRef}
              type="text"
              className="node-picker__search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search pages..."
            />
          </div>
          
          {/* Results List */}
          <div className="node-picker__list">
            {isLoading && query.length > 0 ? (
              <div className="node-picker__loading">Searching...</div>
            ) : filteredResults.length === 0 && !showCreateOption ? (
              <div className="node-picker__empty">
                {query ? 'No matches found' : 'No pages available'}
              </div>
            ) : (
              <>
                {/* Section header for recent nodes */}
                {!query && filteredResults.length > 0 && (
                  <div className="node-picker__section-header">Recent Pages</div>
                )}
                
                {filteredResults.map((node, index) => {
                  const isSelected = Array.isArray(value) 
                    ? value.includes(node.id) 
                    : value === node.id;
                  const isPage = node.parent_id === null;
                  
                  return (
                    <button
                      key={node.id}
                      className={`node-picker__item ${
                        index === selectedIndex ? 'node-picker__item--highlighted' : ''
                      } ${
                        isSelected ? 'node-picker__item--selected' : ''
                      }`}
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
          
          {/* Footer with hint */}
          <div className="node-picker__footer">
            <span className="node-picker__hint">
              {property.class_filters?.length 
                ? `Filtered by ${property.class_filters.length} class${property.class_filters.length > 1 ? 'es' : ''}`
                : 'All pages'}
            </span>
          </div>
        </Card>,
        document.body
      )}
    </div>
  );
}

export default NodePicker;
