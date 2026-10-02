/**
 * View registry — one row per view mode. Views self-register at module
 * bottom (each view file imports this and calls `registerView`); the barrel
 * (`./index.js`) imports every view module for the registration side effect,
 * then re-exports the lookup API. Containers and the switcher introspect the
 * registry instead of switching on mode ids, so future modes (graph, kanban,
 * …) plug in without touching call sites.
 */

import type { ViewCapabilities, ViewMode, ViewRegistryEntry } from "./types.js";

const registry = new Map<string, ViewRegistryEntry>();

export function registerView(entry: ViewRegistryEntry): void {
  registry.set(entry.id, entry);
}

export function unregisterView(id: ViewMode | string): void {
  registry.delete(id);
}

export function getViewDefinition(id: ViewMode | string): ViewRegistryEntry | undefined {
  return registry.get(id);
}

export function getRegisteredViewModes(): ViewRegistryEntry[] {
  return [...registry.values()];
}

export interface ViewModeOption {
  mode: string;
  icon: string;
  label: string;
}

/** Switcher options in registry order, filtered to the available modes. */
export function getViewModeOptions(available?: ViewMode[] | string[]): ViewModeOption[] {
  const all = getRegisteredViewModes();
  const list = available === undefined ? all : available.map((id) => registry.get(id)).filter((entry): entry is ViewRegistryEntry => entry !== undefined);
  return list.map((entry) => ({ mode: entry.id, icon: entry.icon, label: entry.label }));
}

export type { ViewCapabilities };
