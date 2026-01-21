/**
 * PropertyPickerModal Component
 * 
 * Modal for selecting existing properties or creating new ones.
 * Uses search to filter properties and shows an option to create new.
 */
import { useState, useMemo, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import { useProperties } from '@/hooks';
import type { Property, PropertyType } from '@/types/api';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import './PropertyPickerModal.css';

/** System property UUIDs that should be hidden from the "Add property" menu */
const HIDDEN_PROPERTY_UUIDS = new Set<string>([
  SYSTEM_PROPERTY_UUIDS.cover,
  SYSTEM_PROPERTY_UUIDS.types,
  SYSTEM_PROPERTY_UUIDS.show_hierarchy,
]);

// Lazy load to avoid circular dependency
const PropertyCreateModal = lazy(() => import('./PropertyCreateModal'));

interface PropertyPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (property: Property) => void;
  onCreate: (name: string, type: PropertyType, isLocal: boolean) => void;
  /** Property IDs to exclude from the list (already applied) */
  excludeIds?: number[];
}

export function PropertyPickerModal({
  isOpen,
  onClose,
  onSelect,
  onCreate,
  excludeIds = [],
}: PropertyPickerModalProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  
  const { data: allProperties, isLoading } = useProperties();
  
  // Filter properties based on search and exclusions
  const filteredProperties = useMemo(() => {
    if (!allProperties) return [];
    
    const excludeSet = new Set(excludeIds);
    let filtered = allProperties.filter(p => 
      !excludeSet.has(p.id) && !HIDDEN_PROPERTY_UUIDS.has(p.uuid)
    );
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p => 
        p.name.toLowerCase().includes(query)
      );
    }
    
    return filtered;
  }, [allProperties, excludeIds, searchQuery]);
  
  // Check if exact match exists (for "create new" option)
  const exactMatch = useMemo(() => {
    if (!searchQuery.trim()) return false;
    return filteredProperties.some(
      p => p.name.toLowerCase() === searchQuery.toLowerCase()
    );
  }, [filteredProperties, searchQuery]);
  
  // Show "create new" option if search query doesn't match exactly
  const showCreateOption = searchQuery.trim().length > 0 && !exactMatch;
  
  // Total items including create option
  const totalItems = filteredProperties.length + (showCreateOption ? 1 : 0);
  
  // Reset selection when list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredProperties.length, showCreateOption]);
  
  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);
  
  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector('[data-selected="true"]');
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);
  
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
          setShowCreateModal(true);
        } else {
          // Select existing property
          const propIndex = showCreateOption ? selectedIndex - 1 : selectedIndex;
          const property = filteredProperties[propIndex];
          if (property) {
            onSelect(property);
            onClose();
          }
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [totalItems, showCreateOption, selectedIndex, filteredProperties, onSelect, onClose]);
  
  const handleSelectProperty = useCallback((property: Property) => {
    onSelect(property);
    onClose();
  }, [onSelect, onClose]);
  
  const handleCreateNew = useCallback(() => {
    setShowCreateModal(true);
  }, []);
  
  const handleCreateProperty = useCallback((name: string, type: PropertyType, isLocal: boolean) => {
    onCreate(name, type, isLocal);
    setShowCreateModal(false);
    onClose();
  }, [onCreate, onClose]);
  
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };
  
  if (!isOpen) return null;
  
  // Show create modal if triggered
  if (showCreateModal) {
    return (
      <Suspense fallback={<div className="modal-backdrop"><div className="property-picker-loading">Loading...</div></div>}>
        <PropertyCreateModal
          isOpen={true}
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateProperty}
          initialName={searchQuery}
        />
      </Suspense>
    );
  }
  
  return (
    <div className="modal-backdrop property-picker-backdrop" onClick={handleBackdropClick}>
      <div className="property-picker-modal">
        <div className="property-picker-search">
          <input
            ref={inputRef}
            type="text"
            className="property-picker-input"
            placeholder="Search properties or create new..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        
        <div className="property-picker-list" ref={listRef}>
          {isLoading && (
            <div className="property-picker-loading">Loading properties...</div>
          )}
          
          {!isLoading && totalItems === 0 && !showCreateOption && (
            <div className="property-picker-empty">
              No properties found. Type to create a new one.
            </div>
          )}
          
          {/* Create new option */}
          {showCreateOption && (
            <button
              className={`property-picker-item property-picker-create${selectedIndex === 0 ? ' selected' : ''}`}
              data-selected={selectedIndex === 0}
              onClick={handleCreateNew}
            >
              <span className="property-picker-item-icon">+</span>
              <span className="property-picker-item-name">
                Create "{searchQuery}"
              </span>
            </button>
          )}
          
          {/* Existing properties */}
          {filteredProperties.map((property, index) => {
            const itemIndex = showCreateOption ? index + 1 : index;
            const isSelected = selectedIndex === itemIndex;
            
            return (
              <button
                key={property.id}
                className={`property-picker-item${isSelected ? ' selected' : ''}`}
                data-selected={isSelected}
                onClick={() => handleSelectProperty(property)}
              >
                <span className="property-picker-item-icon">
                  {property.icon || getPropertyTypeIcon(property.type)}
                </span>
                <span className="property-picker-item-name">{property.name}</span>
                <span className="property-picker-item-type">{property.type}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Get default icon for property type
 */
function getPropertyTypeIcon(type: PropertyType): string {
  switch (type) {
    case 'text':
      return '';
    case 'integer':
    case 'float':
      return '';
    case 'boolean':
      return '';
    case 'node':
      return '';
    case 'selection':
      return '';
    case 'date':
      return '';
    default:
      return '';
  }
}

export default PropertyPickerModal;
