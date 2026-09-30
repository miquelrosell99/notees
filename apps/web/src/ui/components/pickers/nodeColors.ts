/**
 * Data-level color palette for the node picker's color swatches. These are
 * application data colors (tag/class colors), the same role the legacy
 * `--color-preset-*` data colors played; the design-system tokens stay
 * monochrome. Order matches the legacy picker palette: null = no color
 * first, then red/orange/yellow/green/teal/blue/purple/pink.
 */

export const NODE_PICKER_PALETTE: (string | null)[] = [
  null,
  "#c55a55", // red
  "#c98557", // orange
  "#b8a23a", // yellow
  "#4f8f6a", // green
  "#4a8a83", // teal
  "#5a79c9", // blue
  "#8a6cc9", // purple
  "#c06a9a", // pink
];
