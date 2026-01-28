/**
 * PropertySuggestionPopup - Floating popup for selecting or creating properties
 * 
 * Shows a list of available properties filtered by search query.
 * If no exact match exists, shows "Create new property" option.
 * 
 * When selecting an existing property, it's added to the node.
 * When creating a new property, creates a text property by default
 * and opens the PropertyConfigPanel for editing.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useProperties } from '@/hooks';
import type { Property } from '@/types/api';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { AddIcon, PropertiesIcon, SearchIcon } from '../icons';
import { TextField } from '../core/TextField';
import './PropertySuggestionPopup.css';

/** System property UUIDs that should be hidden from the "Add property" menu */
const HIDDEN_PROPERTY_UUIDS = new Set<string>([
  SYSTEM_PROPERTY_UUIDS.cover,
  SYSTEM_PROPERTY_UUIDS.show_hierarchy,
  SYSTEM_PROPERTY_UUIDS.banner,
]);

export interface PropertySuggestionPopupProps {
  /** Whether the popup is visible */
  isOpen: boolean;
  /** Position to render the popup */
  position: { top: number; left: number };
  /** Callback when an existing property is selected */
  onSelect: (property: Property) => void;
  /** Callback to close the popup */
  onClose: () => void;
  /** Callback when a new property should be created */
  onCreate: (name: string) => void;
  /** Property IDs to exclude from the list (already applied) */
  excludeIds?: number[];
}

export function PropertySuggestionPopup({
  isOpen,
  position,
  onSelect,
  onClose,
  onCreate,
  excludeIds = [],
}: PropertySuggestionPopupProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const { data: allProperties, isLoading } = useProperties();
  
  // Filter properties based on search and exclusions
  const filteredProperties = useMemo(() => {
    if (!allProperties) return [];
    
    const excludeSet = new Set(excludeIds);
    let filtered = allProperties.filter(p => 
      !excludeSet.has(p.id) && !HIDDEN_PROPERTY_UUIDS.has(p.uuid)
    );
    
    if (query.trim()) {
      const q = query.toLowerCase();
      filtered = filtered.filter(p => 
        p.name.toLowerCase().includes(q)
      );
    }
    
    return filtered;
  }, [allProperties, excludeIds, query]);
  
  // Check if exact match exists (for "create new" option)
  const exactMatch = useMemo(() => {
    if (!query.trim()) return false;
    return filteredProperties.some(
      p => p.name.toLowerCase() === query.toLowerCase()
    );
  }, [filteredProperties, query]);
  
  // Show "create new" option if search query doesn't match exactly
  const showCreateOption = query.trim().length > 0 && !exactMatch;
  
  // Total items including create option
  const totalItems = filteredProperties.length + (showCreateOption ? 1 : 0);
  
  // Reset selection when list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredProperties.length, showCreateOption]);
  
  // Focus input and reset state when popup opens
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);
  
  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, totalItems - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (showCreateOption && selectedIndex === 0) {
          // Create new property
          onCreate(query.trim());
        } else {
          // Select existing property
          const propIndex = showCreateOption ? selectedIndex - 1 : selectedIndex;
          const property = filteredProperties[propIndex];
          if (property) {
            onSelect(property);
          }
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case 'Tab':
        e.preventDefault();
        onClose();
        break;
    }
  }, [totalItems, showCreateOption, selectedIndex, filteredProperties, query, onSelect, onCreate, onClose]);
  
  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);
  
  // Adjust position to stay within viewport
  const adjustedPosition = useMemo(() => {
    if (!isOpen) return position;
    
    const popupWidth = 280;
    const popupHeight = 320;
    const padding = 8;
    
    let { top, left } = position;
    
    // Adjust horizontal position
    if (left + popupWidth > window.innerWidth - padding) {
      left = window.innerWidth - popupWidth - padding;
    }
    if (left < padding) {
      left = padding;
    }
    
    // Adjust vertical position - flip above if not enough space below
    if (top + popupHeight > window.innerHeight - padding) {
      top = position.top - popupHeight - 24;
    }
    
    return { top, left };
  }, [isOpen, position]);
  
  if (!isOpen) return null;
  
  return (
    <div
      ref={containerRef}
      className="property-suggestion-popup"
      style={{
        position: 'fixed',
        top: adjustedPosition.top,
        left: adjustedPosition.left,
        zIndex: 1000,
      }}
    >
      <div className="property-suggestion-popup__header">
        <span className="property-suggestion-popup__icon">
          <PropertiesIcon size="sm" />
        </span>
        <span>Add property</span>
      </div>
      
      <div className="property-suggestion-popup__search">
        <TextField
          ref={inputRef}
          type="text"
          className="property-suggestion-popup__input"
          placeholder="Search properties..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          icon={<SearchIcon size="sm" />}
        />
      </div>
      
      <div className="property-suggestion-popup__list">
        {isLoading && query.length > 0 ? (
          <div className="property-suggestion-popup__loading">Searching...</div>
        ) : totalItems === 0 ? (
          <div className="property-suggestion-popup__empty">
            {query ? 'No matches found. Press Enter to create.' : 'Start typing to search or create'}
          </div>
        ) : (
          <>
            {/* Create new option (shown first when there's a query with no exact match) */}
            {showCreateOption && (
              <button
                className={`property-suggestion-popup__item property-suggestion-popup__item--create ${
                  selectedIndex === 0 ? 'property-suggestion-popup__item--selected' : ''
                }`}
                onClick={() => onCreate(query.trim())}
                onMouseEnter={() => setSelectedIndex(0)}
              >
                <span className="property-suggestion-popup__item-icon">
                  <AddIcon size="sm" />
                </span>
                <span className="property-suggestion-popup__item-name">
                  Create "{query.trim()}"
                </span>
                <span className="property-suggestion-popup__item-type">text</span>
              </button>
            )}
            
            {/* Existing properties */}
            {filteredProperties.map((property, index) => {
              const itemIndex = showCreateOption ? index + 1 : index;
              const isSelected = selectedIndex === itemIndex;
              
              return (
                <button
                  key={property.id}
                  className={`property-suggestion-popup__item${isSelected ? ' property-suggestion-popup__item--selected' : ''}`}
                  onClick={() => onSelect(property)}
                  onMouseEnter={() => setSelectedIndex(itemIndex)}
                >
                  {property.icon && (
                    <span className="property-suggestion-popup__item-icon">
                      {property.icon}
                    </span>
                  )}
                  <span className="property-suggestion-popup__item-name">{property.name}</span>
                  <span className="property-suggestion-popup__item-type">{property.type}</span>
                </button>
              );
            })}
          </>
        )}
      </div>
      
      <div className="property-suggestion-popup__footer">
        <span className="property-suggestion-popup__hint">
          <kbd>↑↓</kbd> navigate
        </span>
        <span className="property-suggestion-popup__hint">
          <kbd>Enter</kbd> select
        </span>
      </div>
    </div>
  );
}

export default PropertySuggestionPopup;
