/**
 * NodeSelector - Universal node selection component
 * 
 * Supports two trigger modes:
 * - 'pill-row': Row of node pills with add button (default, for tags/types/classes)
 * - 'select': Dropdown trigger with SelectTrigger (for property values, single/multi)
 * 
 * Features:
 * - Show pills for each node
 * - Navigate to a node on click
 * - Remove a node (optional)
 * - Change a node's color via right-click (optional)
 * - Add new nodes via a picker dropdown using useNodeSearch
 * - Single or multi-select support
 * - Class filtering via classFilters prop
 * - Create new nodes on the fly
 */
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { NodePill } from './NodePill';
import { NodeIcon, AddIcon, BulletIcon, CheckIcon } from './icons';
import { Button } from './core/Button';
import { Card } from './core/Card';
import { SelectTrigger } from './core/SelectTrigger';
import { mdiPlus } from '@mdi/js';
import { useNodeSearch, type NodeSearchMode, usePages, useNodes } from '@/hooks';
import { getEffectiveIcon } from '@/utils/nodeIcon';
import type { Node } from '@/types';
import './NodeSelector.css';

type TriggerMode = 'pill-row' | 'select';

interface NodeSelectorProps {
  /** The nodes to display as pills (or selected values in 'select' mode) */
  nodes?: Node[];
  /** Alternative: provide node IDs instead of Node objects ('select' mode will fetch them) */
  value?: number | number[] | null;
  /** Search mode for the picker - determines what types of nodes to show */
  searchMode?: NodeSearchMode;
  /** Class IDs to filter search results by (nodes must have at least one of these classes) */
  classFilters?: number[];
  /** Trigger style: 'pill-row' (default) or 'select' (dropdown) */
  trigger?: TriggerMode;
  /** Whether multi-select is enabled (only applies to 'select' mode) */
  multi?: boolean;
  /** Placeholder text for empty state */
  placeholder?: string;
  /** Placeholder text for empty state add button (pill-row mode) */
  emptyText?: string;
  /** Placeholder for search input */
  searchPlaceholder?: string;
  /** Callback when clicking a pill (navigate) */
  onNodeClick?: (node: Node) => void;
  /** Callback when removing a node (if provided, shows remove button on pills) */
  onRemove?: (node: Node) => void;
  /** Callback when changing a node's color via right-click (if provided, enables color picker) */
  onColorChange?: (node: Node, color: string | null) => void;
  /** Callback when adding a node from the picker (single-select: replaces; multi-select: adds) */
  onAdd?: (node: Node) => void;
  /** Callback when value changes (for 'select' mode with value prop) */
  onChange?: (value: number | number[] | null) => void;
  /** Callback when creating a new node (if provided, shows create option) */
  onCreateNew?: (name: string) => void | Promise<Node>;
  /** Callback when clearing all selections ('select' mode only) */
  onClearAll?: () => void;
  /** Function to determine if a node can be removed (default: all can be removed) */
  canRemove?: (node: Node) => boolean;
  /** Function to determine if a node can be added (filters search results) */
  canAdd?: (node: Node) => boolean;
  /** Whether pills are read-only (hides remove button) */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

export function NodeSelector({
  nodes: nodesProp,
  value,
  searchMode = 'pages',
  classFilters,
  trigger = 'pill-row',
  multi = false,
  placeholder = 'Select node...',
  emptyText = 'Add',
  searchPlaceholder = 'Search...',
  onNodeClick,
  onRemove,
  onColorChange,
  onAdd,
  onChange,
  onCreateNew,
  onClearAll,
  canRemove,
  canAdd,
  readOnly = false,
  className = '',
}: NodeSelectorProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Fetch data for node lookups (for 'select' mode with value prop)
  const { data: allPages } = usePages();
  const { data: allNodes } = useNodes();

  // Resolve nodes from value prop if using value-based API
  const resolvedNodesFromValue = useMemo(() => {
    if (!value || !allPages) return [];
    const ids = Array.isArray(value) ? value : [value];
    return ids
      .map(id => allPages.find(n => n.id === id) || allNodes?.find(n => n.id === id))
      .filter((n): n is Node => n !== undefined);
  }, [value, allPages, allNodes]);

  // Use either nodes prop or resolved nodes from value
  const nodes = nodesProp ?? resolvedNodesFromValue;

  // Use shared search hook (same as SuggestionPopup)
  const { allResults, isLoading, showCreateOption: searchShowCreate } = useNodeSearch(searchQuery, {
    mode: searchMode,
    classFilters,
    maxResults: trigger === 'select' ? 15 : 10,
  });

  // Convert search results to Node array
  const searchResults = useMemo(() => {
    return allResults.map(r => r.node);
  }, [allResults]);

  // Filter out already assigned nodes and nodes that cannot be added
  const assignedIds = useMemo(() => new Set(nodes.map(n => n.id)), [nodes]);
  
  const filteredResults = useMemo(() => {
    return searchResults
      .filter(node => !assignedIds.has(node.id))
      .filter(node => !canAdd || canAdd(node));
  }, [searchResults, assignedIds, canAdd]);

  // Only show create option if onCreate is provided and there's a query
  const showCreateOption = onCreateNew && searchShowCreate && searchQuery.trim().length > 0;
  
  // Total selectable items
  const totalItems = filteredResults.length + (showCreateOption ? 1 : 0);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredResults.length, searchQuery]);

  // Update menu position for 'select' mode (portal rendering)
  useEffect(() => {
    if (trigger === 'select' && isPickerOpen && containerRef.current) {
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
    } else if (trigger === 'pill-row' && isPickerOpen && buttonRef.current) {
      // Position for pill-row mode (fixed positioning)
      const rect = buttonRef.current.getBoundingClientRect();
      setPickerPos({ top: rect.bottom + 4, left: rect.left });
    } else {
      setMenuPosition(null);
      setPickerPos(null);
    }
  }, [isPickerOpen, trigger]);

  // Close picker when clicking outside
  useEffect(() => {
    if (!isPickerOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const pickerElement = trigger === 'select' ? menuRef.current : pickerRef.current;
      const triggerElement = trigger === 'select' ? containerRef.current : buttonRef.current;
      
      if (
        pickerElement && !pickerElement.contains(target) &&
        triggerElement && !triggerElement.contains(target)
      ) {
        setIsPickerOpen(false);
        setSearchQuery('');
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPickerOpen(false);
        setSearchQuery('');
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isPickerOpen, trigger]);

  // Focus search input when picker opens
  useEffect(() => {
    if (isPickerOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isPickerOpen]);

  const handleAdd = useCallback((node: Node) => {
    if (onChange) {
      // Value-based API: update value
      const newValue = multi
        ? [...(Array.isArray(value) ? value : []), node.id]
        : node.id;
      onChange(newValue);
    } else {
      // Node-based API: call onAdd
      onAdd?.(node);
    }
    
    if (!multi || trigger === 'pill-row') {
      setIsPickerOpen(false);
      setSearchQuery('');
    }
  }, [onChange, onAdd, multi, trigger, value]);

  const handleRemove = useCallback((node: Node) => {
    if (onChange) {
      // Value-based API: update value
      if (multi && Array.isArray(value)) {
        onChange(value.filter(id => id !== node.id));
      } else {
        onChange(null);
      }
    } else {
      // Node-based API: call onRemove
      onRemove?.(node);
    }
  }, [onChange, onRemove, multi, value]);

  const handleCreateNew = useCallback(async () => {
    if (!searchQuery.trim() || !onCreateNew) return;
    const result = onCreateNew(searchQuery.trim());
    
    // If onCreate returns a promise (creates node), wait for it and add it
    if (result instanceof Promise) {
      try {
        const newNode = await result;
        if (newNode) {
          handleAdd(newNode);
        }
      } catch (error) {
        console.error('Failed to create node:', error);
      }
    }
    
    setIsPickerOpen(false);
    setSearchQuery('');
  }, [searchQuery, onCreateNew, handleAdd]);

  const handleClearAll = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onChange) {
      onChange(multi ? [] : null);
    } else {
      onClearAll?.();
    }
    setIsPickerOpen(false);
  }, [onChange, onClearAll, multi]);

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

  // 'select' mode: render SelectTrigger with portal dropdown
  if (trigger === 'select') {
    const hasValue = nodes.length > 0;
    
    // Read-only view
    if (readOnly) {
      return (
        <div className={`node-selector node-selector--select node-selector--readonly ${className}`}>
          {hasValue ? (
            <div className="node-selector__selected-list">
              {nodes.map(node => (
                <button
                  key={node.id}
                  className="node-selector__chip node-selector__chip--readonly"
                  onClick={() => onNodeClick?.(node)}
                >
                  <NodeIcon icon={node.icon} isPage={node.is_page} size="xs" />
                  <span>{node.name || 'Untitled'}</span>
                </button>
              ))}
            </div>
          ) : (
            <span className="node-selector__placeholder">—</span>
          )}
        </div>
      );
    }
    
    return (
      <div className={`node-selector node-selector--select ${className}`} ref={containerRef}>
        {/* SelectTrigger */}
        <SelectTrigger
          isOpen={isPickerOpen}
          disabled={readOnly}
          clearable={!readOnly && hasValue}
          hasValue={hasValue}
          onClick={() => !readOnly && setIsPickerOpen(prev => !prev)}
          onClear={readOnly ? undefined : handleClearAll}
        >
          {hasValue ? (
            multi ? (
              // Multi-select: Show NodePills with remove buttons
              <div className="node-selector__selected-pills">
                {nodes.map(node => (
                  <NodePill
                    key={node.id}
                    nodeId={node.id}
                    onClick={() => onNodeClick?.(node)}
                    onRemove={readOnly ? undefined : () => handleRemove(node)}
                    readOnly={readOnly}
                  />
                ))}
              </div>
            ) : (
              // Single-select: Show effective icon + node name
              (() => {
                const node = nodes[0];
                const effectiveIcon = node ? getEffectiveIcon(node, allPages) : null;
                return (
                  <span className="node-selector__single-value">
                    {effectiveIcon ? (
                      <NodeIcon icon={effectiveIcon} isPage={node.is_page} size="sm" />
                    ) : (
                      <BulletIcon size="sm" />
                    )}
                    <span className="node-selector__single-value-name">
                      {node?.name || 'Untitled'}
                    </span>
                  </span>
                );
              })()
            )
          ) : (
            <span className="node-selector__placeholder">{placeholder}</span>
          )}
        </SelectTrigger>
        
        {/* Dropdown Menu - Rendered in Portal */}
        {isPickerOpen && menuPosition && createPortal(
          <Card
            ref={menuRef}
            className="node-selector__dropdown node-selector__dropdown--portal"
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
            <div className="node-selector__search-wrapper">
              <input
                ref={searchInputRef}
                type="text"
                className="node-selector__search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
              />
            </div>
            
            {/* Results List */}
            <div className="node-selector__list">
              {isLoading && searchQuery.length > 0 ? (
                <div className="node-selector__loading">Searching...</div>
              ) : filteredResults.length === 0 && !showCreateOption ? (
                <div className="node-selector__empty">
                  {searchQuery ? 'No matches found' : 'Start typing to search'}
                </div>
              ) : (
                <>
                  {filteredResults.map((node, index) => {
                    const isSelected = assignedIds.has(node.id);
                    return (
                      <button
                        key={node.id}
                        className={`node-selector__item ${
                          index === selectedIndex ? 'node-selector__item--highlighted' : ''
                        } ${
                          isSelected ? 'node-selector__item--selected' : ''
                        }`}
                        onClick={() => handleAdd(node)}
                        onMouseEnter={() => setSelectedIndex(index)}
                      >
                        <span className="node-selector__item-icon">
                          <NodeIcon icon={node.icon} isPage={node.is_page} size="sm" />
                        </span>
                        <span className="node-selector__item-name">
                          {node.name || 'Untitled'}
                        </span>
                        {isSelected && (
                          <span className="node-selector__item-check"><CheckIcon size="xs" /></span>
                        )}
                      </button>
                    );
                  })}
                  
                  {showCreateOption && (
                    <button
                      className={`node-selector__item node-selector__item--create ${
                        selectedIndex === filteredResults.length ? 'node-selector__item--highlighted' : ''
                      }`}
                      onClick={handleCreateNew}
                      onMouseEnter={() => setSelectedIndex(filteredResults.length)}
                    >
                      <span className="node-selector__item-icon">
                        <AddIcon size="sm" />
                      </span>
                      <span className="node-selector__item-name">
                        Create "{searchQuery.trim()}"
                      </span>
                    </button>
                  )}
                </>
              )}
            </div>
            
            {/* Footer with hint */}
            {classFilters && classFilters.length > 0 && (
              <div className="node-selector__footer">
                <span className="node-selector__hint">
                  Filtered by {classFilters.length} class{classFilters.length > 1 ? 'es' : ''}
                </span>
              </div>
            )}
          </Card>,
          document.body
        )}
      </div>
    );
  }

  // 'pill-row' mode: original behavior
  const showAddButton = !!onAdd;

  return (
    <div className={`node-selector ${className}`}>
      {nodes.map((node) => {
        const isRemovable = onRemove && (!canRemove || canRemove(node));
        return (
          <NodePill
            key={node.id}
            node={node}
            onClick={() => onNodeClick?.(node)}
            onRemove={isRemovable ? () => onRemove(node) : undefined}
            onColorChange={onColorChange ? (color) => onColorChange(node, color) : undefined}
            readOnly={readOnly}
          />
        );
      })}
      
      {showAddButton && (
        <div className="node-selector__add-wrapper" ref={buttonRef}>
          <Button
            variant="ghost"
            size="xs"
            icon={mdiPlus}
            className="node-selector__add-btn"
            onClick={() => setIsPickerOpen(!isPickerOpen)}
            title={emptyText}
          >
            {nodes.length === 0 ? emptyText : ''}
          </Button>
          
          {isPickerOpen && pickerPos && (
            <div
              className="node-selector__picker"
              ref={pickerRef}
              style={{ top: pickerPos.top, left: pickerPos.left }}
            >
              <input
                ref={searchInputRef}
                type="text"
                className="node-selector__search"
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <div className="node-selector__options">
                {isLoading && searchQuery.length > 0 ? (
                  <div className="node-selector__loading">Searching...</div>
                ) : filteredResults.length === 0 && !showCreateOption ? (
                  <div className="node-selector__no-results">
                    {searchQuery ? 'No matches found' : 'Start typing to search'}
                  </div>
                ) : (
                  <>
                    {filteredResults.map((node, index) => (
                      <button
                        key={node.id}
                        className={`node-selector__option ${index === selectedIndex ? 'node-selector__option--selected' : ''}`}
                        onClick={() => handleAdd(node)}
                        onMouseEnter={() => setSelectedIndex(index)}
                      >
                        <NodeIcon icon={node.icon} isPage={true} size="xs" />
                        <span>{node.name || 'Untitled'}</span>
                      </button>
                    ))}
                    {showCreateOption && (
                      <button
                        className={`node-selector__option node-selector__option--create ${
                          selectedIndex === filteredResults.length ? 'node-selector__option--selected' : ''
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

export default NodeSelector;

