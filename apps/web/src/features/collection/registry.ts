/**
 * View registry — one row per view mode. Views self-register at module
 * bottom (each view file imports this and calls `registerView`); the barrel
 * (`./index.js`) imports every view module for the registration side effect,
 * then re-exports the lookup API. Containers and the switcher introspect the
 * registry instead of switching on mode ids, so future modes plug in
 * without touching call sites.
 */

import type { ViewAvailabilityContext, ViewCapabilities, ViewMode, ViewRegistryEntry } from "./types.js";

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
  tier?: "primary" | "secondary";
}

/** Switcher options in registry order, filtered to the available modes. */
export function getViewModeOptions(available?: ViewMode[] | string[]): ViewModeOption[] {
  const all = getRegisteredViewModes();
  const list = available === undefined ? all : available.map((id) => registry.get(id)).filter((entry): entry is ViewRegistryEntry => entry !== undefined);
  return list.map((entry) => ({
    mode: entry.id,
    icon: entry.icon,
    label: entry.label,
    ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
  }));
}

/**
 * availableViewModes — the availability gate: keeps every mode without an
 * availability declaration (always available) and every declared mode whose
 * declaration the collection-fed context satisfies. Hosts run their modes
 * through this BEFORE the switcher and the mode resolution, so a gated mode
 * never renders and never rides the switcher; unregistered ids pass through
 * untouched (hosts may name modes the registry does not carry — the
 * switcher already drops those via getViewModeOptions).
 */
export function availableViewModes(
  modes: readonly (ViewMode | string)[],
  ctx: ViewAvailabilityContext,
): (ViewMode | string)[] {
  return modes.filter((id) => {
    const entry = registry.get(id);
    if (entry === undefined || entry.availability === undefined) return true;
    return entry.availability(ctx);
  });
}

export type { ViewAvailabilityContext };

export type { ViewCapabilities };
