import type { Property, Node } from '@/types/api';
import { getPropertyValueRenderer } from './propertyValueRegistry';
// Eagerly register all property value renderers
import './registerPropertyRenderers';

interface PropertyValueProps {
  property: Property;
  nodeId: number;
  value: unknown;
  readOnly?: boolean;
  onChange: (value: unknown) => void;
  onNavigateToNode?: (nodeId: number) => void;
  onCreatePage?: (name: string, additionalClasses?: number[]) => Promise<Node>;
  onOpenInSidebar?: (nodeId: number) => void;
  onPropertyChange: (propertyId: number, value: unknown) => void;
  /** Callback when text property bullet is clicked (opens focused block view) */
  onBulletClick?: (blockId: number) => void;
}

/**
 * Render a property value based on its type.
 *
 * Uses the Property Value Registry to look up the renderer for the
 * property's type. Each renderer is registered in
 * registerPropertyRenderers.ts.
 */
export function PropertyValue(props: PropertyValueProps) {
  const renderer = getPropertyValueRenderer(props.property.type);

  if (!renderer) {
    return <span className="property-value-unknown">{String(props.value ?? '')}</span>;
  }

  const Component = renderer.component;
  return <Component {...props} />;
}
