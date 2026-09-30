/**
 * Data-level color palette for the node picker's color swatches. These are
 * application data colors (tag/class colors); the design-system tokens stay
 * monochrome. Order: null = no color first, then
 * red/orange/yellow/green/teal/blue/purple/pink.
 *
 * Values come from the shared preset entries in the UI primitives library
 * so every picker shows the same data palette.
 */

import { PRESET_COLOR_ENTRIES } from "../ui/colorPresets.js";

export const NODE_PICKER_PALETTE: (string | null)[] = [
  null,
  ...PRESET_COLOR_ENTRIES.map((entry) => entry.cssVar),
];
