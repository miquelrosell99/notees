/**
 * Data-level color grammar (owner 2026-10-03, implementation-plan §34.43).
 *
 * A node/class `color` is ONE string field carrying either a preset token
 * or a custom hex color. This replaces the first v3 encoding — CSS variable
 * references (`var(--color-preset-red)`) — which leaked a web technology
 * onto the wire and drifted between clients (Flutter stored resolved hexes).
 * The token/hex split is client-neutral, strictly validatable, keeps theme
 * remapping (the concrete hex lives client-side, keyed by token), and keeps
 * freeform custom colors without a schema change.
 *
 * `null` on a color field means CLEAR (object.update gains the capability
 * here — the UI's "No color" was a protocol no-op until now; class.update
 * documented "null clears" but the old string-only schema never accepted it).
 *
 * Stored logs still carrying the retired `var(--color-preset-*)` encoding
 * are rewritten in place by the one-time migration
 * (scripts/migrate-color-tokens.mts); payload schemas reject that encoding
 * outright — no backward compatibility (owner directive).
 *
 * The token SET is normative here; display ORDER is a client concern (web:
 * hue order then gray — variables.css / colorPresets.ts).
 */

import { z } from "zod";

/** The ten preset tokens, hue order (red → pink) then gray. */
export const COLOR_PRESET_TOKENS = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "sky",
  "blue",
  "purple",
  "pink",
  "gray",
] as const;

export type ColorToken = (typeof COLOR_PRESET_TOKENS)[number];

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #RRGGBB");

/** A stored color value: preset token or custom #RRGGBB hex. */
export const colorValueSchema = z.union([z.enum(COLOR_PRESET_TOKENS), hexColor]);

/** True when `value` is a stored color (preset token or #RRGGBB hex). */
export function isColorValue(value: unknown): value is string {
  return colorValueSchema.safeParse(value).success;
}
