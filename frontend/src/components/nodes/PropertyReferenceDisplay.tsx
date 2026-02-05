/**
 * NodeProperty Component
 * 
 * Reusable component for displaying a single property row.
 * Used in both PropertiesSection and linked references.
 */
import type { Property } from '@/types';
import { Bullet } from '../blocks/Bullet';
import './PropertyReferenceDisplay.css';

export interface NodePropertyProps {
  /** The property definition */
  property: Property;
  /** The property value */
  value: unknown;
  /** Property source (e.g., type name) */
  source?: string;
  /** Read-only mode */
  readOnly?: boolean;
  /** Callback when navigating to a node */
  onNavigateToNode?: (nodeId: number) => void;
  /** Callback when opening in sidebar */
  onOpenInSidebar?: (nodeId: number) => void;
  /** Callback when property name is right-clicked */
  onPropertyNameClick?: (property: Property, event: React.MouseEvent) => void;
  /** Show decorative bullet (default: true) */
  showBullet?: boolean;
  /** Compact display mode */
  compact?: boolean;
}

export function NodeProperty({
  property,
  value,
  source,
  readOnly = false,
  onNavigateToNode,
  onOpenInSidebar,
  onPropertyNameClick,
  showBullet = true,
  compact = false,
}: NodePropertyProps) {
  const handleTextPropertyBulletClick = (blockId: number) => {
    onNavigateToNode?.(blockId);
  };

  // Simple value formatting
  const formatValue = (val: unknown): string => {
    if (val === null || val === undefined) return '';
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    if (typeof val === 'number') return String(val);
    if (typeof val === 'string') return val;
    return String(val);
  };

  // Render node-type property value (clickable)
  const renderNodeValue = (val: unknown) => {
    if (typeof val === 'number') {
      return (
        <button
          className="property-node-link"
          onClick={() => onNavigateToNode?.(val)}
          disabled={readOnly}
        >
          Node #{val}
        </button>
      );
    }
    return formatValue(val);
  };

  return (
    <div className={`node-property-row ${compact ? 'node-property-row--compact' : ''}`}>
      <button
        className="node-property-label"
        onClick={(e) => !readOnly && onPropertyNameClick?.(property, e)}
        onContextMenu={(e) => !readOnly && onPropertyNameClick?.(property, e)}
        disabled={readOnly}
        title={readOnly ? undefined : "Right-click to open menu"}
      >
        {property.icon && <span className="node-property-icon">{property.icon}</span>}
        <span className="node-property-name">{property.name}</span>
        {source && <span className="node-property-source" title={`From ${source}`}>({source})</span>}
      </button>
      <div className="node-property-value-container">
        <div className="node-property-value-wrapper">
          {/* Bullet for various property types */}
          {showBullet && property.type !== 'text' && property.type !== 'node' && (
            <Bullet interactive={false} size="xs" />
          )}
          {/* Interactive bullet for text properties */}
          {showBullet && property.type === 'text' && (
            <Bullet 
              nodeId={typeof value === 'number' ? value : undefined}
              interactive={!readOnly && typeof value === 'number'}
              onClick={() => typeof value === 'number' && handleTextPropertyBulletClick(value)}
              onShiftClick={(blockId) => onOpenInSidebar?.(blockId)}
              size="xs"
            />
          )}
          {/* Interactive bullet for node properties */}
          {showBullet && property.type === 'node' && !property.multi && (
            <Bullet 
              nodeId={typeof value === 'number' ? value : undefined}
              interactive={!readOnly && typeof value === 'number'}
              onClick={() => typeof value === 'number' && onNavigateToNode?.(value)}
              onShiftClick={(nodeId) => onOpenInSidebar?.(nodeId)}
              size="xs"
            />
          )}
          <div className="node-property-value">
            {/* Handle multi-valued properties */}
            {Array.isArray(value) && property.multi ? (
              <div className="property-multi-values">
                {value.map((val, idx) => (
                  <span key={idx} className="property-value-item">
                    {property.type === 'node' ? renderNodeValue(val) : formatValue(val)}
                    {idx < value.length - 1 && ', '}
                  </span>
                ))}
              </div>
            ) : (
              property.type === 'node' ? renderNodeValue(value) : formatValue(value)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default NodeProperty;
