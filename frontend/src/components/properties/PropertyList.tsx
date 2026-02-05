/**
 * PropertyList Component
 * 
 * A reusable component for displaying a list of property rows.
 * Extracted from PropertiesSection to be reusable in other contexts.
 * 
 * Features:
 * - Property rows with labels and values using Block component for consistent styling
 * - Hidden properties section
 * - Context menu support (at row level)
 * - Bullet points for non-text properties
 * - Default icons for property types when no custom icon is set
 * 
 * NOTE: Moved out of core/ - has domain knowledge (Property type)
 */
import { useState, useCallback, useMemo, type ReactNode } from 'react';
import type { Property, PropertyType, Node } from '@/types/api';
import { useNodesStore } from '@/stores';
import { Block } from '../blocks/Block';
import { Bullet } from '../blocks/Bullet';
import { ChevronRightIcon } from '../icons';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import './PropertyList.css';

/** Default icons for each property type */
const PROPERTY_TYPE_ICONS: Record<PropertyType, string> = {
  text: '📝',
  integer: '#️⃣',
  float: '🔢',
  boolean: '☑️',
  date: '📅',
  selection: '📋',
  node: '🔗',
};

/** Get icon for a property - uses custom icon if set, otherwise default for type */
function getPropertyIcon(property: Property): string {
  return property.icon || PROPERTY_TYPE_ICONS[property.type] || '📄';
}

export interface PropertyEntry {
  /** The property definition */
  property: Property;
  /** Current value */
  value: unknown;
  /** Source of the property (e.g., type name) */
  source?: string;
  /** Whether this property is hidden by default */
  hidden?: boolean;
}

export interface PropertyListProps {
  /** List of property entries to display */
  properties: PropertyEntry[];
  /** Whether the list is read-only */
  readOnly?: boolean;
  /** Whether to show hidden properties section */
  showHiddenSection?: boolean;
  /** Whether hidden section is initially expanded */
  defaultShowHidden?: boolean;
  /** Render function for property values */
  renderValue: (entry: PropertyEntry, readOnly: boolean) => ReactNode;
  /** Handler for property name clicks (for editing) */
  onPropertyNameClick?: (property: Property, event: React.MouseEvent) => void;
  /** Handler for property name right-clicks (context menu) */
  onPropertyContextMenu?: (property: Property, event: React.MouseEvent) => void;
  /** Context menu items generator */
  getContextMenuItems?: (property: Property) => ContextMenuItem[];
  /** Additional className */
  className?: string;
  /** Variant for styling */
  variant?: 'page' | 'block';
  /** Whether to show bullets before values */
  showBullets?: boolean;
}

/**
 * PropertyList component for displaying property rows.
 */
export function PropertyList({
  properties,
  readOnly = false,
  showHiddenSection = true,
  defaultShowHidden = false,
  renderValue,
  onPropertyNameClick,
  onPropertyContextMenu,
  getContextMenuItems,
  className = '',
  variant = 'page',
  showBullets = true,
}: PropertyListProps) {
  const [showHidden, setShowHidden] = useState(defaultShowHidden);

  // Split into visible and hidden properties
  const visibleProperties = properties.filter(p => !p.hidden);
  const hiddenProperties = properties.filter(p => p.hidden);

  const variantClass = variant === 'block' ? 'property-list--block' : '';

  return (
    <div className={`property-list ${variantClass} ${className}`}>
      {/* Visible properties */}
      <div className="property-list__items">
        {visibleProperties.map(entry => (
          <PropertyRow
            key={entry.property.id}
            entry={entry}
            readOnly={readOnly}
            renderValue={renderValue}
            onNameClick={onPropertyNameClick}
            onPropertyContextMenu={onPropertyContextMenu}
            getContextMenuItems={getContextMenuItems}
            showBullet={showBullets && entry.property.type !== 'text'}
          />
        ))}
      </div>

      {/* Hidden properties section */}
      {showHiddenSection && hiddenProperties.length > 0 && (
        <div className="property-list__hidden-section">
          <button
            className={`property-list__hidden-toggle ${showHidden ? 'expanded' : ''}`}
            onClick={() => setShowHidden(!showHidden)}
          >
            <ChevronRightIcon size="xs" />
            <span>Hidden properties ({hiddenProperties.length})</span>
          </button>

          {showHidden && (
            <div className="property-list__hidden-items">
              {hiddenProperties.map(entry => (
                <PropertyRow
                  key={entry.property.id}
                  entry={entry}
                  readOnly={readOnly}
                  renderValue={renderValue}
                  onNameClick={onPropertyNameClick}
                  onPropertyContextMenu={onPropertyContextMenu}
                  getContextMenuItems={getContextMenuItems}
                  showBullet={showBullets && entry.property.type !== 'text'}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface PropertyRowProps {
  entry: PropertyEntry;
  readOnly: boolean;
  renderValue: (entry: PropertyEntry, readOnly: boolean) => ReactNode;
  onNameClick?: (property: Property, event: React.MouseEvent) => void;
  onPropertyContextMenu?: (property: Property, event: React.MouseEvent) => void;
  getContextMenuItems?: (property: Property) => ContextMenuItem[];
  showBullet: boolean;
}

/**
 * PropertyRow component - renders a single property row with context menu
 * Uses Block component in readonly mode for the property name display
 */
function PropertyRow({
  entry,
  readOnly,
  renderValue,
  onNameClick,
  onPropertyContextMenu,
  getContextMenuItems,
  showBullet,
}: PropertyRowProps) {
  const { property, source } = entry;
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  
  // Get navigation functions from store
  const openPropertyView = useNodesStore(state => state.openPropertyView);
  const addSidebarCard = useNodesStore(state => state.addSidebarCard);

  const handleNameClick = useCallback((e: React.MouseEvent) => {
    if (!readOnly && onNameClick) {
      onNameClick(property, e);
    }
  }, [readOnly, onNameClick, property]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (readOnly || !getContextMenuItems) return;
    e.preventDefault();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
    onPropertyContextMenu?.(property, e);
  }, [readOnly, property, onPropertyContextMenu, getContextMenuItems]);

  // Generate context menu items for this row
  const contextMenuItems = getContextMenuItems ? getContextMenuItems(property) : [];
  
  // Handle bullet click - opens property page
  const handleBulletClick = useCallback(() => {
    openPropertyView(property.id);
  }, [openPropertyView, property.id]);
  
  // Handle shift+click on bullet - opens property in sidebar
  const handleBulletShiftClick = useCallback(() => {
    addSidebarCard({ type: 'property', id: property.id });
  }, [addSidebarCard, property.id]);

  // Create a minimal node for the Block component to display the property name
  const propertyAsNode = useMemo<Node>(() => ({
    id: property.id,
    uuid: property.uuid,
    name: property.name,
    icon: getPropertyIcon(property),
    color: null,
    parent_id: null,
    page_id: null,
    sequence: 0,
    collapsed: false,
    active: true,
    is_page: false,
    create_date: property.create_date,
    write_date: property.write_date,
  }), [property]);

  return (
    <>
      <div className="property-row" onClick={handleNameClick} onContextMenu={handleContextMenu}>
        <div
          className="property-row__label"
          title={!readOnly && getContextMenuItems ? 'Right-click for options' : undefined}
        >
          <Block
            block={propertyAsNode}
            parentId={null}
            showBullet={true}
            showChildren={false}
            showClasses={false}
            canMove={false}
            canEdit={false}
            canSelect={false}
            isolatedState={true}
            onBulletClick={handleBulletClick}
            onShiftClick={handleBulletShiftClick}
            customContextMenuItems={contextMenuItems}
          />
          {source && (
            <span className="property-row__source" title={`From ${source}`}>
              ({source})
            </span>
          )}
        </div>
        <div className="property-row__value-container">
          <div className="property-row__value-wrapper">
            {showBullet && (
              <Bullet interactive={false} size="xs" />
            )}
            {renderValue(entry, readOnly)}
          </div>
        </div>
      </div>

      {/* Context Menu - rendered at row level */}
      {showContextMenu && contextMenuItems.length > 0 && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenuPosition}
          onClose={() => setShowContextMenu(false)}
        />
      )}
    </>
  );
}

export default PropertyList;
