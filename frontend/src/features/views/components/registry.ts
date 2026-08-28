/**
 * View Registry
 *
 * Declarative registry for NodeCollection view modes.
 * Each view self-registers its component, metadata, and capabilities.
 * This eliminates the central switch statement in NodeCollection
 * and makes the toolbar introspect view capabilities dynamically.
 */
import type { ComponentType, LazyExoticComponent } from 'react';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';

export interface ViewCapabilities {
  /** View supports groupBy selector */
  groupBy?: boolean;
  /** View supports card layout selector */
  cardLayout?: boolean;
  /** View supports property column selector */
  propertyColumns?: boolean;
  /** View supports gantt date property / time scale config */
  ganttConfig?: boolean;
  /** View supports explicit multi-column sort popup */
  sorting?: boolean;
  /** View should be wrapped in ErrorBoundary */
  errorBoundary?: boolean;
  /** View should be wrapped in Card when containerCard=true */
  containerCard?: boolean;
}

export interface ViewRegistryEntry {
  /** Built-in modes use NodeCollectionViewMode; plugins may register custom string ids. */
  id: NodeCollectionViewMode | string;
  label: string;
  icon: string;

  component: ComponentType<any> | LazyExoticComponent<ComponentType<any>>;
  capabilities: ViewCapabilities;
}

const registry = new Map<string, ViewRegistryEntry>();

export function registerView(entry: ViewRegistryEntry): void {
  registry.set(entry.id, entry);
}

export function unregisterView(id: NodeCollectionViewMode | string): void {
  registry.delete(id);
}

export function getViewDefinition(
  mode: NodeCollectionViewMode | string
): ViewRegistryEntry | undefined {
  return registry.get(mode);
}

export function getRegisteredViewModes(): (NodeCollectionViewMode | string)[] {
  return Array.from(registry.keys());
}

export function getViewModeOptions(): {
  mode: NodeCollectionViewMode | string;
  icon: string;
  label: string;
}[] {
  return Array.from(registry.values()).map((entry) => ({
    mode: entry.id,
    icon: entry.icon,
    label: entry.label,
  }));
}
