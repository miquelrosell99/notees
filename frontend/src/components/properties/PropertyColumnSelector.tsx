/**
 * PropertyColumnSelector Component
 * 
 * A panel for selecting which property columns to show in table view.
 * Includes a searchbox and checkboxes for each property.
 * Supports drag-and-drop reordering of selected properties.
 */
import { useState, useMemo } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useProperties } from '@/hooks';
import { Checkbox } from '../core/Checkbox';
import { SearchIcon } from '../icons';
import type { Property } from '@/types';
import './PropertyColumnSelector.css';

// ==================== SortablePropertyItem ====================

interface SortablePropertyItemProps {
  property: Property;
  onToggle: (uuid: string) => void;
}

function SortablePropertyItem({ property, onToggle }: SortablePropertyItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: property.uuid });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <label
      ref={setNodeRef}
      style={style}
      className="property-column-selector__item property-column-selector__item--draggable"
      {...attributes}
    >
      <span className="property-column-selector__drag-handle" {...listeners}>⋮⋮</span>
      <Checkbox
        checked={true}
        onChange={() => onToggle(property.uuid)}
      />
      <span className="property-column-selector__item-content">
        {property.icon && (
          <span className="property-column-selector__item-icon">
            {property.icon}
          </span>
        )}
        <span className="property-column-selector__item-name">
          {property.name}
        </span>
        <span className="property-column-selector__item-type">
          {property.type}
        </span>
      </span>
    </label>
  );
}

// ==================== Main Component ====================

export interface PropertyColumnSelectorProps {
  /** Currently selected property UUIDs */
  selectedPropertyUuids: string[];
  /** Callback when selection changes */
  onSelectionChange: (propertyUuids: string[]) => void;
  /** Optional close callback (passed from ButtonWithPanel) */
  onClose?: () => void;
}

/**
 * PropertyColumnSelector - Select which properties to show as columns
 */
export function PropertyColumnSelector({
  selectedPropertyUuids,
  onSelectionChange,
}: PropertyColumnSelectorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const { data: properties = [], isLoading } = useProperties();

  // Filter properties based on search
  const filteredProperties = useMemo(() => {
    if (!searchQuery) return properties;
    const query = searchQuery.toLowerCase();
    return properties.filter(prop => 
      prop.name.toLowerCase().includes(query) ||
      (prop.icon && prop.icon.toLowerCase().includes(query))
    );
  }, [properties, searchQuery]);
  
  // Create ordered list of selected properties for display
  const selectedProperties = useMemo(() => {
    return selectedPropertyUuids
      .map(uuid => properties.find(p => p.uuid === uuid))
      .filter(p => p !== undefined);
  }, [selectedPropertyUuids, properties]);

  // Handle checkbox change
  const handleToggle = (propertyUuid: string) => {
    const isSelected = selectedPropertyUuids.includes(propertyUuid);
    if (isSelected) {
      onSelectionChange(selectedPropertyUuids.filter(uuid => uuid !== propertyUuid));
    } else {
      onSelectionChange([...selectedPropertyUuids, propertyUuid]);
    }
  };

  // Handle select all / deselect all
  const handleSelectAll = () => {
    const allUuids = filteredProperties.map(p => p.uuid);
    onSelectionChange(allUuids);
  };

  const handleDeselectAll = () => {
    onSelectionChange([]);
  };

  if (isLoading) {
    return (
      <div className="property-column-selector">
        <div className="property-column-selector__loading">Loading properties...</div>
      </div>
    );
  }

  return (
    <div className="property-column-selector">
      <div className="property-column-selector__header">
        <h3 className="property-column-selector__title">Select Columns</h3>
        <div className="property-column-selector__actions">
          <button 
            className="property-column-selector__action-btn"
            onClick={handleSelectAll}
            disabled={filteredProperties.length === 0}
          >
            Select All
          </button>
          <button 
            className="property-column-selector__action-btn"
            onClick={handleDeselectAll}
            disabled={selectedPropertyUuids.length === 0}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="property-column-selector__search">
        <div className="property-column-selector__search-box">
          <SearchIcon size="sm" />
          <input
            type="text"
            className="property-column-selector__search-input"
            placeholder="Search properties..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="property-column-selector__list">
        {/* Selected properties (draggable, ordered) */}
        {selectedProperties.length > 0 && (
          <div className="property-column-selector__selected-group">
            <div className="property-column-selector__group-header">Selected ({selectedProperties.length})</div>
            <SortableContext items={selectedPropertyUuids} strategy={verticalListSortingStrategy}>
              {selectedProperties.map((property) => (
                <SortablePropertyItem
                  key={property.uuid}
                  property={property}
                  onToggle={handleToggle}
                />
              ))}
            </SortableContext>
          </div>
        )}
        
        {/* Unselected properties (searchable) */}
        {filteredProperties.length > 0 && (
          <div className="property-column-selector__available-group">
            {selectedProperties.length > 0 && (
              <div className="property-column-selector__group-header">Available</div>
            )}
            {filteredProperties
              .filter(prop => !selectedPropertyUuids.includes(prop.uuid))
              .map(property => (
                <label
                  key={property.uuid}
                  className="property-column-selector__item"
                >
                  <Checkbox
                    checked={false}
                    onChange={() => handleToggle(property.uuid)}
                  />
                  <span className="property-column-selector__item-content">
                    {property.icon && (
                      <span className="property-column-selector__item-icon">
                        {property.icon}
                      </span>
                    )}
                    <span className="property-column-selector__item-name">
                      {property.name}
                    </span>
                    <span className="property-column-selector__item-type">
                      {property.type}
                    </span>
                  </span>
                </label>
              ))}
          </div>
        )}
        
        {filteredProperties.length === 0 && selectedProperties.length === 0 && (
          <div className="property-column-selector__empty">
            {searchQuery ? 'No properties found' : 'No properties available'}
          </div>
        )}
      </div>

      <div className="property-column-selector__footer">
        <span className="property-column-selector__count">
          {selectedPropertyUuids.length} selected
        </span>
      </div>
    </div>
  );
}
