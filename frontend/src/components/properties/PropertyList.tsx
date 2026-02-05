/**
 * PropertyList Component
 * 
 * A reusable component for displaying a list of property rows.
 * Extracted from PropertiesSection to be reusable in other contexts.
 * 
 * Features:
 * - Property rows with labels and values
 * - Hidden properties section
 * - Context menu support (at row level)
 * - Bullet points for non-text properties
 * 
 * NOTE: Moved out of core/ - has domain knowledge (Property type)
 */
import { useState, useCallback, type ReactNode } from 'react';
import type { Property } from '@/types/api';
import { Bullet } from '../blocks/Bullet';
import { ChevronRightIcon } from '../icons';
import { ContextMenu, type ContextMenuItem } from '../core/ContextMenu';
import './PropertyList.css';

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

  return (
    <>
      <div className="property-row">
        <div
          className="property-row__label"
          onContextMenu={handleContextMenu}
          title={!readOnly && getContextMenuItems ? 'Right-click for options' : undefined}
        >
          {property.icon && <span className="property-row__icon">{property.icon}</span>}
          <span className="property-row__name">{property.name}</span>
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
