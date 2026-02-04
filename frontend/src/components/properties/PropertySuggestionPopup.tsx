/**
 * PropertySuggestionPopup - Inline dropdown for selecting or creating properties
 * 
 * Shows a list of available properties filtered by search query.
 * If no exact match exists, shows "Create new property" option.
 * 
 * When selecting an existing property, it's added to the node.
 * When creating a new property, creates a text property by default
 * and opens the PropertyConfigPanel for editing.
 * 
 * Uses the same dropdown pattern as NodePillRow for consistency.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useProperties } from '@/hooks';
import type { Property } from '@/types/api';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { AddIcon, PropertiesIcon } from '../icons';
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

  // Handle property selection
  const handleSelect = useCallback((property: Property) => {
    onSelect(property);
    setQuery('');
  }, [onSelect]);

  const handleCreate = useCallback(() => {
    if (!query.trim()) return;
    onCreate(query.trim());
    setQuery('');
  }, [query, onCreate]);
  
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
        if (selectedIndex < filteredProperties.length) {
          handleSelect(filteredProperties[selectedIndex]);
        } else if (showCreateOption) {
          handleCreate();
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        setQuery('');
        break;
    }
  }, [totalItems, showCreateOption, selectedIndex, filteredProperties, handleSelect, handleCreate, onClose]);
  
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
  
  if (!isOpen) return null;
  
  return (
    <div
      ref={containerRef}
      className="property-suggestion-popup"
    >
      <input
        ref={inputRef}
        type="text"
        className="property-suggestion-popup__search"
        placeholder="Search properties..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="property-suggestion-popup__options">
        {isLoading && query.length > 0 ? (
          <div className="property-suggestion-popup__loading">Searching...</div>
        ) : filteredProperties.length === 0 && !showCreateOption ? (
          <div className="property-suggestion-popup__no-results">
            {query ? 'No matches found' : 'Start typing to search'}
          </div>
        ) : (
          <>
            {/* Existing properties */}
            {filteredProperties.map((property, index) => (
              <button
                key={property.id}
                className={`property-suggestion-popup__option ${index === selectedIndex ? 'property-suggestion-popup__option--selected' : ''}`}
                onClick={() => handleSelect(property)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                {property.icon && (
                  <span className="property-suggestion-popup__option-icon">
                    {property.icon}
                  </span>
                )}
                <span className="property-suggestion-popup__option-name">{property.name}</span>
                <span className="property-suggestion-popup__option-type">{property.type}</span>
              </button>
            ))}
            
            {/* Create new option */}
            {showCreateOption && (
              <button
                className={`property-suggestion-popup__option property-suggestion-popup__option--create ${
                  selectedIndex === filteredProperties.length ? 'property-suggestion-popup__option--selected' : ''
                }`}
                onClick={handleCreate}
                onMouseEnter={() => setSelectedIndex(filteredProperties.length)}
              >
                <span className="property-suggestion-popup__option-icon">
                  <AddIcon size="xs" />
                </span>
                <span>Create "{query.trim()}"</span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default PropertySuggestionPopup;