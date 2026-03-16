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
import { useQuery } from '@tanstack/react-query';
import { useProperties, useAvailableProperties } from '@/hooks';
import { useKeyboardListNav } from '@/hooks/useKeyboardListNav';
import type { Property, PropertyType, PropertyCreate, PropertyScope } from '@/types/api';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import { getPropertySuggestions } from '@/api/properties';
import { AddIcon, NodeIcon } from '../core/icons';
import { PropertyCreateModal } from './PropertyCreateModal';

/** Default MDI icons for each property type (used when no custom icon is set) */
const PROPERTY_TYPE_ICONS: Record<PropertyType, string> = {
  text: 'mdiFormatText',
  integer: 'mdiPound',
  float: 'mdiDecimal',
  boolean: 'mdiCheckboxMarkedOutline',
  date: 'mdiCalendar',
  selection: 'mdiFormatListBulleted',
  node: 'mdiLink',
  url: 'mdiLinkVariant',
  email: 'mdiEmail',
  image: 'mdiImage',
};
import './PropertySuggestionPopup.css';

/** System property UUIDs that should be hidden from the "Add property" menu */
const HIDDEN_PROPERTY_UUIDS = new Set<string>([
  SYSTEM_PROPERTY_UUIDS.cover,
  SYSTEM_PROPERTY_UUIDS.show_hierarchy,
  SYSTEM_PROPERTY_UUIDS.banner,
  SYSTEM_PROPERTY_UUIDS._query_ast,
  SYSTEM_PROPERTY_UUIDS._whiteboard_data,
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
  /** Context node ID — enables node-scoped properties in results and "Create node-local" option */
  contextNodeId?: number;
  /** Context class IDs — enables class-scoped properties in results and "Create class-local" option */
  contextClassIds?: number[];
  /** Default scope for newly created properties when "Create global" button is clicked (default: 'global') */
  defaultScope?: PropertyScope;
}

/** Scope badge labels */
const SCOPE_BADGE: Record<string, string> = {
  class: '@',
  node: '●',
};

export function PropertySuggestionPopup({
  isOpen,
  onSelect,
  onClose,
  onCreate,
  excludeIds = [],
  contextNodeId,
  contextClassIds,
  defaultScope,
}: PropertySuggestionPopupProps) {
  const [query, setQuery] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [initialPropertyName, setInitialPropertyName] = useState('');
  const [initialPropertyScope, setInitialPropertyScope] = useState<PropertyScope>('global');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasContext = contextNodeId != null || (contextClassIds?.length ?? 0) > 0;
  const { data: allProperties, isLoading } = useAvailableProperties(
    hasContext ? { contextNodeId, contextClassIds } : {}
  );

  // Fetch usage-ranked suggestions to sort properties by popularity
  const { data: suggestions } = useQuery({
    queryKey: ['property-suggestions', contextNodeId],
    queryFn: () => getPropertySuggestions(contextNodeId ?? undefined),
    enabled: isOpen,
    staleTime: 30_000,
  });
  
  // Filter properties based on search and exclusions, sorted by usage
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

    // Sort by usage count (most used first)
    if (suggestions?.length) {
      const usageMap = new Map(suggestions.map(s => [s.property_id, s.usage_count]));
      filtered.sort((a, b) => (usageMap.get(b.id) ?? 0) - (usageMap.get(a.id) ?? 0));
    }
    
    return filtered;
  }, [allProperties, excludeIds, query, suggestions]);
  
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

  const handleCreate = useCallback((scope: PropertyScope = defaultScope ?? 'global') => {
    if (!query.trim()) return;
    setInitialPropertyName(query.trim());
    setInitialPropertyScope(scope);
    setShowCreateModal(true);
  }, [query, defaultScope]);

  // Keyboard list navigation — Enter triggers create with defaultScope
  const handleSelectByIndex = useCallback((index: number) => {
    if (index < filteredProperties.length) {
      handleSelect(filteredProperties[index]);
    } else if (showCreateOption) {
      handleCreate(defaultScope ?? 'global');
    }
  }, [filteredProperties, showCreateOption, handleSelect, handleCreate, defaultScope]);

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
      setInitialPropertyScope(defaultScope ?? 'global');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, defaultScope]);
  
  const handleCreateConfirm = useCallback((data: PropertyCreate & { selection_options?: { name: string; icon?: string }[] }) => {
    onCreate(data);
    setQuery('');
    setInitialPropertyName('');
    setShowCreateModal(false);
  }, [onCreate]);
  
  const handleCreateCancel = useCallback(() => {
    setShowCreateModal(false);
    setInitialPropertyName('');
    setInitialPropertyScope(defaultScope ?? 'global');
  }, [defaultScope]);
  
  // Close on click outside (disabled while create modal is open to avoid
  // portal clicks being treated as "outside" the popup container)
  useEffect(() => {
    if (!isOpen || showCreateModal) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, showCreateModal, onClose]);
  
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
                <span className="property-suggestion-popup__option-icon">
                  <NodeIcon icon={property.icon || PROPERTY_TYPE_ICONS[property.type]} size="xs" />
                </span>
                <span className="property-suggestion-popup__option-name">{property.name}</span>
                {property.scope && property.scope !== 'global' && (
                  <span
                    className={`property-suggestion-popup__scope-badge property-suggestion-popup__scope-badge--${property.scope}`}
                    title={property.scope === 'class' ? 'Class property' : 'Node-local property'}
                  >
                    {SCOPE_BADGE[property.scope]}
                  </span>
                )}
                <span className="property-suggestion-popup__option-type">{property.type}</span>
              </button>
            ))}
            
            {/* Create options */}
            {showCreateOption && (
              <>
                {/* Primary create button (keyboard accessible) */}
                <button
                  className={`property-suggestion-popup__option property-suggestion-popup__option--create ${
                    selectedIndex === filteredProperties.length ? 'property-suggestion-popup__option--selected' : ''
                  }`}
                  onClick={() => handleCreate(defaultScope ?? 'global')}
                  onMouseEnter={() => setSelectedIndex(filteredProperties.length)}
                >
                  <span className="property-suggestion-popup__option-icon">
                    <AddIcon size="xs" />
                  </span>
                  <span>Create "{query.trim()}"</span>
                  {defaultScope && defaultScope !== 'global' && (
                    <span className={`property-suggestion-popup__scope-badge property-suggestion-popup__scope-badge--${defaultScope}`}>
                      {SCOPE_BADGE[defaultScope]}
                    </span>
                  )}
                </button>

                {/* Alternate scope options */}
                {hasContext && (defaultScope ?? 'global') !== 'global' && (
                  <button
                    className="property-suggestion-popup__option property-suggestion-popup__option--create-alt"
                    onClick={() => handleCreate('global')}
                  >
                    <span className="property-suggestion-popup__option-icon">
                      <AddIcon size="xs" />
                    </span>
                    <span>Create "{query.trim()}" as global</span>
                  </button>
                )}
                {contextClassIds?.length && (defaultScope ?? 'global') !== 'class' && (
                  <button
                    className="property-suggestion-popup__option property-suggestion-popup__option--create-alt"
                    onClick={() => handleCreate('class')}
                  >
                    <span className="property-suggestion-popup__option-icon">
                      <AddIcon size="xs" />
                    </span>
                    <span>Create "{query.trim()}" as class-local</span>
                    <span className="property-suggestion-popup__scope-badge property-suggestion-popup__scope-badge--class">@</span>
                  </button>
                )}
                {contextNodeId != null && (defaultScope ?? 'global') !== 'node' && (
                  <button
                    className="property-suggestion-popup__option property-suggestion-popup__option--create-alt"
                    onClick={() => handleCreate('node')}
                  >
                    <span className="property-suggestion-popup__option-icon">
                      <AddIcon size="xs" />
                    </span>
                    <span>Create "{query.trim()}" as node-local</span>
                    <span className="property-suggestion-popup__scope-badge property-suggestion-popup__scope-badge--node">●</span>
                  </button>
                )}
              </>
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
      initialScope={initialPropertyScope}
    />
  </>
  );
}

export default PropertySuggestionPopup;
