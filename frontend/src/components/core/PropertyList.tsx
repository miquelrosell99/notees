/**
 * PropertyList Component
 * 
 * A reusable component for displaying a list of property rows.
 * Extracted from PropertiesSection to be reusable in other contexts.
 */
import { useState, useCallback, type ReactNode } from 'react';
import type { Property } from '@/types/api';
import { Bullet } from '../Bullet';
import { ChevronRightIcon } from '../icons';
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
  showBullet: boolean;
}

function PropertyRow({
  entry,
  readOnly,
  renderValue,
  onNameClick,
  showBullet,
}: PropertyRowProps) {
  const { property, source } = entry;

  const handleNameClick = useCallback((e: React.MouseEvent) => {
    if (!readOnly && onNameClick) {
      onNameClick(property, e);
    }
  }, [readOnly, onNameClick, property]);

  return (
    <div className="property-row">
      <button
        className={`property-row__label ${!readOnly && onNameClick ? 'property-row__label--clickable' : ''}`}
        onClick={handleNameClick}
        disabled={readOnly || !onNameClick}
        title={!readOnly && onNameClick ? 'Click to edit property' : undefined}
      >
        {property.icon && <span className="property-row__icon">{property.icon}</span>}
        <span className="property-row__name">{property.name}</span>
        {source && (
          <span className="property-row__source" title={`From ${source}`}>
            ({source})
          </span>
        )}
      </button>
      <div className="property-row__value-container">
        <div className="property-row__value-wrapper">
          {showBullet && (
            <Bullet interactive={false} size="xs" />
          )}
          {renderValue(entry, readOnly)}
        </div>
      </div>
    </div>
  );
}

export default PropertyList;
