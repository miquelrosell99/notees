/**
 * NodePillRow - A generic row of node pills with optional add button
 * 
 * Used for displaying types and tags on pages with the ability to:
 * - Show pills for each node
 * - Navigate to a node on click
 * - Remove a node (optional)
 * - Add new nodes via a picker dropdown (optional)
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { NodeTypePill } from './NodeTypePill';
import { NodeIcon } from './icons';
import { Button } from './core/Button';
import { mdiPlus } from '@mdi/js';
import type { Node } from '@/types';
import './NodePillRow.css';

interface NodePillRowProps {
  /** The nodes to display as pills */
  nodes: Node[];
  /** Available nodes for the add picker (if provided, shows add button) */
  availableNodes?: Node[];
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
  /** Function to determine if a node can be removed (default: all can be removed) */
  canRemove?: (node: Node) => boolean;
  /** Whether pills are read-only (hides remove button) */
  readOnly?: boolean;
  /** Additional CSS class */
  className?: string;
}

export function NodePillRow({
  nodes,
  availableNodes,
  emptyText = 'Add',
  searchPlaceholder = 'Search...',
  onNodeClick,
  onRemove,
  onAdd,
  canRemove,
  readOnly = false,
  className = '',
}: NodePillRowProps) {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Filter available nodes by search query
  const filteredNodes = availableNodes?.filter(n => 
    !searchQuery || n.name?.toLowerCase().includes(searchQuery.toLowerCase())
  ) ?? [];

  const handleAdd = useCallback((node: Node) => {
    onAdd?.(node);
    setIsPickerOpen(false);
    setSearchQuery('');
  }, [onAdd]);

  const showAddButton = !!availableNodes && !!onAdd;

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
              />
              <div className="node-pill-row__options">
                {filteredNodes.slice(0, 10).map((node) => (
                  <button
                    key={node.id}
                    className="node-pill-row__option"
                    onClick={() => handleAdd(node)}
                  >
                    <NodeIcon icon={node.icon} isPage={true} size="xs" />
                    <span>{node.name}</span>
                  </button>
                ))}
                {filteredNodes.length === 0 && (
                  <div className="node-pill-row__no-results">No results found</div>
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
