/**
 * NodePillRow - A generic row of node pills with optional add button
 * 
 * Used for displaying types and tags on pages with the ability to:
 * - Show pills for each node
 * - Navigate to a node on click
 * - Remove a node (optional)
 * - Add new nodes via a picker dropdown using useNodeSearch (same as SuggestionPopup)
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { NodeTypePill } from './NodeTypePill';
import { NodeIcon, AddIcon } from './icons';
import { Button } from './core/Button';
import { mdiPlus } from '@mdi/js';
import { useNodeSearch, type NodeSearchMode } from '@/hooks';
import type { Node } from '@/types';
import './NodePillRow.css';

interface NodePillRowProps {
  /** The nodes to display as pills */
  nodes: Node[];
  /** Search mode for the picker - determines what types of nodes to show */
  searchMode?: NodeSearchMode;
  /** Placeholder text for empty state add button */
  emptyText?: string;
  /** Placeholder for search input */
  searchPlaceholder?: string;
  /** Callback when clicking a pill (navigate) */
  onNodeClick?: (node: Node) => void;
  /** Callback when removing a node (if provided, shows remove button on pills) */
  onRemove?: (node: Node) => void;
  /** Callback when adding a node from the picker */
  onAdd?: (node: Node) => void;
  /** Callback when creating a new node (if provided, shows create option) */
  onCreateNew?: (name: string) => void;
  /** Function to determine if a node can be removed (default: all can be removed) */
  canRemove?: (node: Node) => boolean;
  /** Whether pills are read-only (hides remove button) */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

export function NodePillRow({
  nodes,
  searchMode = 'pages',
  emptyText = 'Add',
  searchPlaceholder = 'Search...',
  onNodeClick,
  onRemove,
  onAdd,
  onCreateNew,
  canRemove,
  readOnly = false,
  className = '',
}: NodePillRowProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Use shared search hook (same as SuggestionPopup)
  const { pageResults, isLoading, showCreateOption: searchShowCreate } = useNodeSearch(searchQuery, {
    mode: searchMode,
    maxResults: 10,
  });

  // Filter out already assigned nodes
  const assignedIds = useMemo(() => new Set(nodes.map(n => n.id)), [nodes]);
  
  const filteredResults = useMemo(() => {
    return pageResults
      .filter(item => !assignedIds.has(item.node.id))
      .map(item => item.node);
  }, [pageResults, assignedIds]);

  // Only show create option if onCreate is provided and there's a query
  const showCreateOption = onCreateNew && searchShowCreate && searchQuery.trim().length > 0;
  
  // Total selectable items
  const totalItems = filteredResults.length + (showCreateOption ? 1 : 0);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredResults.length, searchQuery]);

  // Close picker when clicking outside
  useEffect(() => {
    if (!isPickerOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as HTMLElement)) {
        setIsPickerOpen(false);
        setSearchQuery('');
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isPickerOpen]);

  // Focus search input when picker opens
  useEffect(() => {
    if (isPickerOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isPickerOpen]);

  const handleAdd = useCallback((node: Node) => {
    onAdd?.(node);
    setIsPickerOpen(false);
    setSearchQuery('');
  }, [onAdd]);

  const handleCreateNew = useCallback(() => {
    if (!searchQuery.trim()) return;
    onCreateNew?.(searchQuery.trim());
    setIsPickerOpen(false);
    setSearchQuery('');
  }, [searchQuery, onCreateNew]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
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
          handleAdd(filteredResults[selectedIndex]);
        } else if (showCreateOption) {
          handleCreateNew();
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsPickerOpen(false);
        setSearchQuery('');
        break;
    }
  }, [totalItems, selectedIndex, filteredResults, showCreateOption, handleAdd, handleCreateNew]);

  const showAddButton = !!onAdd;

  return (
    <div className={`node-pill-row ${className}`}>
      {nodes.map((node) => {
        const isRemovable = onRemove && (!canRemove || canRemove(node));
        return (
          <NodeTypePill
            key={node.id}
            typeNode={node}
            onClick={() => onNodeClick?.(node)}
            onRemove={isRemovable ? () => onRemove(node) : undefined}
            readOnly={readOnly}
          />
        );
      })}
      
      {showAddButton && (
        <div className="node-pill-row__add-wrapper" ref={pickerRef}>
          <Button
            variant="ghost"
            size="xs"
            icon={mdiPlus}
            className="node-pill-row__add-btn"
            onClick={() => setIsPickerOpen(!isPickerOpen)}
            title={emptyText}
          >
            {nodes.length === 0 ? emptyText : ''}
          </Button>
          
          {isPickerOpen && (
            <div className="node-pill-row__picker">
              <input
                ref={searchInputRef}
                type="text"
                className="node-pill-row__search"
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <div className="node-pill-row__options">
                {isLoading && searchQuery.length > 0 ? (
                  <div className="node-pill-row__loading">Searching...</div>
                ) : filteredResults.length === 0 && !showCreateOption ? (
                  <div className="node-pill-row__no-results">
                    {searchQuery ? 'No matches found' : 'Start typing to search'}
                  </div>
                ) : (
                  <>
                    {filteredResults.map((node, index) => (
                      <button
                        key={node.id}
                        className={`node-pill-row__option ${index === selectedIndex ? 'node-pill-row__option--selected' : ''}`}
                        onClick={() => handleAdd(node)}
                        onMouseEnter={() => setSelectedIndex(index)}
                      >
                        <NodeIcon icon={node.icon} isPage={true} size="xs" />
                        <span>{node.name || 'Untitled'}</span>
                      </button>
                    ))}
                    {showCreateOption && (
                      <button
                        className={`node-pill-row__option node-pill-row__option--create ${
                          selectedIndex === filteredResults.length ? 'node-pill-row__option--selected' : ''
                        }`}
                        onClick={handleCreateNew}
                        onMouseEnter={() => setSelectedIndex(filteredResults.length)}
                      >
                        <AddIcon size="xs" />
                        <span>Create "{searchQuery.trim()}"</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NodePillRow;
