/**
 * Property Value Registry
 *
 * Declarative registry for property value rendering.
 * Each property type self-registers its renderer, eliminating the central
 * switch statements in PropertyValue.tsx, PropertyCell.tsx, and consumers.
 *
 * Usage:
 *   const renderer = getPropertyValueRenderer(property.type);
 *   if (!renderer) return <span>Unknown type</span>;
 *   return <renderer.component {...props} />;
 */

import type { ComponentType } from 'react';
import type { Property, Node } from '@/types/api';

// ==================== Props Types ====================

export interface PropertyValueProps {
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

export interface PropertyCellProps {
  node: Node;
  property: Property;
  value: unknown;
  editable?: boolean;
}

// ==================== Registry Interface ====================

export interface PropertyValueRenderer {
  /** Property type identifier */
  type: string;

  /** Human-readable label */
  label: string;

  /** MDI icon name (without mdi- prefix) */
  icon: string;

  /** Main inline value renderer (PropertyValue.tsx) */
  component: ComponentType<PropertyValueProps>;

  /** Table cell renderer (PropertyCell.tsx). Falls back to component if absent. */
  cellComponent?: ComponentType<PropertyCellProps>;

  /** Default value when a property is first added to a node */
  getDefaultValue(): unknown;

  /** Format raw value as a display string for non-editing contexts */
  formatValue(value: unknown): string;

  /**
   * Resolve group label and icon for ListView/CardView grouping headers.
   * Returns { label, icon } where icon is an MDI icon name or null.
   */
  getGroupInfo(property: Property, rawValue: unknown): { label: string; icon: string | null };

  /**
   * Compare two values for sorting.
   * Return negative if a < b, positive if a > b, 0 if equal.
   */
  compareValues(a: unknown, b: unknown, property: Property): number;
}

const registry = new Map<string, PropertyValueRenderer>();

/**
 * Register a property value renderer.
 * Call once per property type at module load time.
 */
export function registerPropertyValueRenderer(renderer: PropertyValueRenderer): void {
  if (registry.has(renderer.type)) {
    console.warn(`PropertyValueRenderer for type "${renderer.type}" is being overwritten.`);
  }
  registry.set(renderer.type, renderer);
}

/**
 * Get the registered renderer for a property type.
 */
export function getPropertyValueRenderer(type: string): PropertyValueRenderer | undefined {
  return registry.get(type);
}

/**
 * Get all registered property types.
 */
export function getRegisteredPropertyTypes(): string[] {
  return Array.from(registry.keys());
}

/**
 * Get all registered renderers.
 */
export function getRegisteredRenderers(): PropertyValueRenderer[] {
  return Array.from(registry.values());
}
