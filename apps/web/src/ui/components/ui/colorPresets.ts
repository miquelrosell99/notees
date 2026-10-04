/**
 * Data-level semantic color presets.
 *
 * These are NOT design tokens — they are application data colors for
 * tags, statuses, node colors, class pills, and selection options. The
 * design-system tokens stay monochrome.
 *
 * Wire grammar (packages/protocol/src/colors.ts, §34.43): stored colors are
 * preset TOKENS (`"sky"`) or custom `#RRGGBB` hex — never CSS syntax. The
 * concrete preset hex lives only in variables.css (`--color-preset-*`), so
 * themes remap the palette without rewriting node data.
 *
 * Two render-side helpers bridge stored values:
 *  - `cssColorFor(stored)` — a CSS value for style props (token →
 *    `var(--color-preset-<token>)`, hex passthrough);
 *  - `resolveCssColor(stored)` — a concrete hex for math (contrast, canvas;
 *    token → PRESET_HEX, hex passthrough). PRESET_HEX mirrors variables.css
 *    and a parity test (color-presets.test.ts) fails on drift.
 *
 * `canonicalColor(stored)` folds the retired v1 CSS-variable encoding
 * (`var(--color-preset-red)`) to its token — render tolerance for data
 * read before the §34.43 log migration / client re-sync window closes; the
 * wire schemas reject that encoding outright.
 */

import { COLOR_PRESET_TOKENS, type ColorToken } from "@notees/protocol";

/** token → concrete hex. MUST mirror variables.css `--color-preset-*`. */
export const PRESET_HEX: Record<ColorToken, string> = {
  red: "#e34d45",
  orange: "#ed822b",
  yellow: "#f3b816",
  green: "#30a66f",
  teal: "#27a59c",
  sky: "#20a9e9",
  blue: "#4072e7",
  purple: "#9662da",
  pink: "#de4996",
  gray: "#8c857d",
};

export const PRESET_COLOR_TOKENS: readonly ColorToken[] = COLOR_PRESET_TOKENS;

export interface ColorEntry {
  /** Stored value emitted when the swatch is selected (the preset token). */
  value: string;
  /** Human-readable label shown as tooltip */
  label: string;
}

export const PRESET_COLOR_ENTRIES: ColorEntry[] = [
  { value: "red", label: "Red" },
  { value: "orange", label: "Orange" },
  { value: "yellow", label: "Yellow" },
  { value: "green", label: "Green" },
  { value: "teal", label: "Teal" },
  { value: "sky", label: "Light blue" },
  { value: "blue", label: "Blue" },
  { value: "purple", label: "Purple" },
  { value: "pink", label: "Pink" },
  { value: "gray", label: "Gray" },
] as const;

const LEGACY_VAR_PATTERN = /^var\(--color-preset-([a-z]+)\)$/;

/** True when `value` is one of the preset tokens. */
export function isPresetToken(value: string): value is ColorToken {
  return (COLOR_PRESET_TOKENS as readonly string[]).includes(value);
}

/**
 * Folds the retired CSS-variable encoding to its token; everything else
 * (tokens, custom hex) passes through unchanged.
 */
export function canonicalColor(stored: string): string {
  const match = LEGACY_VAR_PATTERN.exec(stored.trim());
  return match !== null && isPresetToken(match[1]!) ? match[1]! : stored;
}

/**
 * A CSS color value for style props: a preset token becomes its themed
 * `var(--color-preset-*)` reference; custom hex passes through.
 */
export function cssColorFor(stored: string): string {
  const value = canonicalColor(stored);
  return isPresetToken(value) ? `var(--color-preset-${value})` : value;
}

/**
 * Resolve a stored color to a concrete hex: preset tokens map to PRESET_HEX,
 * custom hex passes through. For computed use only (contrast, canvas) —
 * pass colors to CSS via `cssColorFor`.
 */
export function resolveCssColor(color: string): string {
  const value = canonicalColor(color).trim();
  return isPresetToken(value) ? PRESET_HEX[value] : value;
}

/**
 * A colored pill's inline style (PG16 option colors): the themed background
 * plus a readable foreground (WCAG-ish relative luminance threshold — the
 * same convention NodePills uses for class pills). Null when no color is
 * set, so callers can spread unconditionally.
 */
export function coloredPillStyle(
  stored: string | null | undefined,
): { background: string; color: string } | undefined {
  if (stored === null || stored === undefined || stored === "") return undefined;
  const resolved = resolveCssColor(stored);
  const match = /^#([0-9a-f]{6})$/i.exec(resolved);
  const foreground =
    match === null
      ? "var(--color-on-primary-container)"
      : (() => {
          const rgb = parseInt(match[1]!, 16);
          const channel = (shift: number) => ((rgb >> shift) & 0xff) / 255;
          const luminance =
            0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
          return luminance > 0.45 ? "var(--color-black)" : "var(--color-white)";
        })();
  return { background: cssColorFor(stored), color: foreground };
}
