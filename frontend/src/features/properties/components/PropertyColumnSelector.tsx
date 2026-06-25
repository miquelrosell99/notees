/**
 * PropertyColumnSelector Component
 * 
 * A panel for selecting which property columns to show in table view.
 * Includes a searchbox and checkboxes for each property.
 * Supports drag-and-drop reordering of selected properties.
 * 
 * Also supports special virtual columns like "Classes" that aren't actual properties.
 */
import { useState, useMemo, useCallback } from 'react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useProperties } from '../hooks';
import { Checkbox } from '@/components/ui/Checkbox';
import { Spinner } from '@/components/ui/Spinner';
import { SearchIcon, DragVerticalIcon } from '@/components/ui/icons';
import type { Property } from '@/types';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants';
import './PropertyColumnSelector.css';

// Virtual columns (not real properties, but can be shown as table columns)
const CLASSES_VIRTUAL_COLUMN = {
  uuid: '__classes__',
  name: 'Classes',
  icon: '',
  type: 'Node',
  id: -1,
  multi: true,
  is_system: true,
  create_date: '',
  write_date: '',
} as const;

const CREATED_VIRTUAL_COLUMN = {
  uuid: '__created__',
  name: 'Created',
  icon: '',
  type: 'Date',
  id: -2,
  multi: false,
  is_system: true,
  create_date: '',
  write_date: '',
} as const;

const MODIFIED_VIRTUAL_COLUMN = {
  uuid: '__modified__',
  name: 'Modified',
  icon: '',
  type: 'Date',
  id: -3,
  multi: false,
  is_system: true,
  create_date: '',
  write_date: '',
} as const;

// ==================== SortablePropertyItem ====================

type ColumnItem = Property | typeof CLASSES_VIRTUAL_COLUMN | typeof CREATED_VIRTUAL_COLUMN | typeof MODIFIED_VIRTUAL_COLUMN;

interface SortablePropertyItemProps {
  property: ColumnItem;
  onToggle: (propertyUuid: string) => void;
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
    <div
      ref={setNodeRef}
      style={style}
      className="property-column-selector__item property-column-selector__item--draggable"
      {...attributes}
    >
      <span className="property-column-selector__drag-handle icon-only-touch-target" {...listeners}>
        <DragVerticalIcon size="xs" />
      </span>
      <Checkbox
        checked={true}
        onChange={() => onToggle(property.uuid)}
      />
      <span className="property-column-selector__item-content">
        <span className="property-column-selector__item-name">
          {property.name}
        </span>
        <span className="property-column-selector__item-type">
          {property.type.toUpperCase()}
        </span>
      </span>
    </div>
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

  // Filter out hidden properties (show_hierarchy) and combine with virtual columns
  const allColumns = useMemo<ColumnItem[]>(() => {
    const filtered = properties.filter(
      prop => prop.uuid !== SYSTEM_PROPERTY_UUIDS.show_hierarchy
    );
    // Add virtual columns first: Created, Modified, Classes, then regular properties
    return [CREATED_VIRTUAL_COLUMN, MODIFIED_VIRTUAL_COLUMN, CLASSES_VIRTUAL_COLUMN, ...filtered];
  }, [properties]);

  // Filter columns based on search
  const filteredProperties = useMemo(() => {
    if (!searchQuery) return allColumns;
    const query = searchQuery.toLowerCase();
    return allColumns.filter(prop => 
      prop.name.toLowerCase().includes(query) ||
      (prop.icon && prop.icon.toLowerCase().includes(query))
    );
  }, [allColumns, searchQuery]);
  
  // Create ordered list of selected properties for display
  const selectedProperties = useMemo(() => {
    return selectedPropertyUuids
      .map(propertyUuid => allColumns.find(p => p.uuid === propertyUuid))
      .filter(p => p !== undefined);
  }, [selectedPropertyUuids, allColumns]);

  // Handle checkbox change
  const handleToggle = (propertyUuid: string) => {
    const isSelected = selectedPropertyUuids.includes(propertyUuid);
    if (isSelected) {
      onSelectionChange(selectedPropertyUuids.filter(selectedPropertyUuid => selectedPropertyUuid !== propertyUuid));
    } else {
      onSelectionChange([...selectedPropertyUuids, propertyUuid]);
    }
  };

  // Handle select all / deselect all
  const handleSelectAll = () => {
    const allPropertyUuids = filteredProperties.map(p => p.uuid);
    onSelectionChange(allPropertyUuids);
  };

  const handleDeselectAll = () => {
    onSelectionChange([]);
  };

  // Handle drag end to reorder selected properties
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    
    if (!over || active.id === over.id) return;
    
    const oldIndex = selectedPropertyUuids.indexOf(active.id as string);
    const newIndex = selectedPropertyUuids.indexOf(over.id as string);
    
    if (oldIndex !== -1 && newIndex !== -1) {
      const reordered = arrayMove(selectedPropertyUuids, oldIndex, newIndex);
      onSelectionChange(reordered);
    }
  }, [selectedPropertyUuids, onSelectionChange]);

  if (isLoading) {
    return (
      <div className="property-column-selector">
        <div className="property-column-selector__loading"><Spinner size="sm" label="Loading properties..." /></div>
      </div>
    );
  }

  return (
    <DndContext
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
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
              .map(property => {
                return (
                  <>
                    {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- Row click toggles the checkbox for pointer users; keyboard users can focus the Checkbox directly. */}
                    <div
                      key={property.uuid}
                      className="property-column-selector__item"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('input, label')) return;
                        handleToggle(property.uuid);
                      }}
                    >
                      <Checkbox
                        checked={false}
                        onChange={() => handleToggle(property.uuid)}
                      />
                      <span className="property-column-selector__item-content">
                        <span className="property-column-selector__item-name">
                          {property.name}
                        </span>
                        <span className="property-column-selector__item-type">
                          {property.type.toUpperCase()}
                        </span>
                      </span>
                    </div>
                  </>
                );
              })}
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
    </DndContext>
  );
}
