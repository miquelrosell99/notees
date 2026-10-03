/**
 * Data-level color palette for the node picker's color swatches. These are
 * application data colors (tag/class colors); the design-system tokens stay
 * monochrome. Order: null = no color first, then the shared preset entries
 * (red/orange/yellow/green/teal/light-blue/blue/purple/pink/gray).
 *
 * Values come from the shared preset entries in the UI primitives library
 * so every picker shows the same data palette. Stored values are preset
 * tokens (or custom hex) — see colorPresets.ts for the wire grammar.
 */

import { PRESET_COLOR_ENTRIES } from "../ui/colorPresets.js";

export const NODE_PICKER_PALETTE: (string | null)[] = [
  null,
  ...PRESET_COLOR_ENTRIES.map((entry) => entry.value),
];
