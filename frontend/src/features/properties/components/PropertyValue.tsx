import type { Property, Node } from '@/types/api';
import { getPropertyValueRenderer } from '../utils/propertyValueRegistry';
// Eagerly register all property value renderers
import '../utils/registerPropertyRenderers';

interface PropertyValueProps {
  property: Property;
  nodeUuid: string;
  value: unknown;
  readOnly?: boolean;
  onChange: (value: unknown) => void;
  onNavigateToNode?: (nodeUuid: string) => void;
  onCreatePage?: (name: string, additionalClasses?: string[]) => Promise<Node>;
  onOpenInSidebar?: (nodeUuid: string) => void;
  onPropertyChange: (propertyId: string, value: unknown) => void;
  /** Callback when text property bullet is clicked (opens focused block view) */
  onBulletClick?: (blockId: string) => void;
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
