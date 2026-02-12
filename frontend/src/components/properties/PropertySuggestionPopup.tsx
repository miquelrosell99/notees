/**
 * PropertySuggestionPopup - Inline dropdown for selecting or creating properties
 * 
 * Shows a list of available properties filtered by search query.
 * If no exact match exists, shows "Create new property" option.
 * 
 * When selecting an existing property, it's added to the node.
 * When creating a new property, opens PropertyCreateModal for configuration.
 * 
 * Uses the same dropdown pattern as NodeSelector for consistency.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useProperties } from '@/hooks';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import type { Property, PropertyType, PropertyCreate } from '@/types/api';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { AddIcon } from '../core/icons';
import { PropertyCreateModal } from './PropertyCreateModal';
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
  onCreate: (data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => void;
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
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [initialPropertyName, setInitialPropertyName] = useState('');
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

  // Handle property selection
  const handleSelect = useCallback((property: Property) => {
    onSelect(property);
    setQuery('');
  }, [onSelect]);

  const handleCreate = useCallback(() => {
    if (!query.trim()) return;
    setInitialPropertyName(query.trim());
    setShowCreateModal(true);
  }, [query]);

  // Keyboard list navigation
  const handleSelectByIndex = useCallback((index: number) => {
    if (index < filteredProperties.length) {
      handleSelect(filteredProperties[index]);
    } else if (showCreateOption) {
      handleCreate();
    }
  }, [filteredProperties, showCreateOption, handleSelect, handleCreate]);

  const handleClose = useCallback(() => {
    onClose();
    setQuery('');
  }, [onClose]);

  const { selectedIndex, setSelectedIndex, handleKeyDown } = useKeyboardListNav({
    totalItems,
    onSelect: handleSelectByIndex,
    onClose: handleClose,
    isOpen,
  });

  // Focus input when popup opens
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setShowCreateModal(false);
      setInitialPropertyName('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);
  
  const handleCreateConfirm = useCallback((data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => {
    onCreate(data);
    setQuery('');
    setInitialPropertyName('');
    setShowCreateModal(false);
  }, [onCreate]);
  
  const handleCreateCancel = useCallback(() => {
    setShowCreateModal(false);
    setInitialPropertyName('');
  }, []);
  
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
    <>
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
    
    {/* Property creation modal */}
    <PropertyCreateModal
      isOpen={showCreateModal}
      onClose={handleCreateCancel}
      onCreate={handleCreateConfirm}
      initialName={initialPropertyName}
    />
  </>
  );
}

export default PropertySuggestionPopup;
