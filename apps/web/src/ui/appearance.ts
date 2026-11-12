/**
 * appearance — the ONE appearance-resolution module.
 *
 * Both writers of the appearance data-* attributes resolve through here:
 *
 * - `applyAppearance()` (components/modals/deviceSettings.ts) — the runtime
 *   writer, called on boot and on every settings change;
 * - the inline bootstrap in index.html — pre-paint, so it cannot import this
 *   module; it mirrors `resolveAppearanceAttributes` VERBATIM, and
 *   test/appearance-bootstrap-parity.test.ts executes BOTH implementations
 *   against a scenario matrix and fails the gate on any drift between them.
 *
 * Pre-paint trio only: theme / oled / accent. The other data-* attributes
 * (font, focus) are runtime-only — a late flip there costs no theme flash.
 */

export const APPEARANCE_KEYS = {
  theme: "notees.settings.theme",
  oledMode: "notees.settings.oledMode",
  accentColor: "notees.settings.accentColor",
} as const;

/** The legacy pre-settings key the theme used to live under; fallback only. */
export const LEGACY_THEME_KEY = "notees.theme";

/** The curated accent picker values (the [data-accent] blocks in variables.css). */
export const ACCENT_VALUES = ["margin", "monochrome", "brown", "teal", "blue"] as const;

export interface AppearanceAttributes {
  theme: "light" | "dark";
  oled: "true" | "false";
  accent: string;
}

/** JSON.parse a raw localStorage value; null on absence or malformed data. */
function parseStored(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve the persisted appearance settings to the concrete data-attribute
 * values. `readRaw` reads a localStorage key verbatim (raw string or null);
 * `systemDark` is the live `prefers-color-scheme` answer. Defaults: system
 * theme, OLED off, the brand accent. Stored values are validated — anything
 * unrecognized falls through to the default, never onto the DOM.
 */
export function resolveAppearanceAttributes(
  readRaw: (key: string) => string | null,
  systemDark: boolean,
): AppearanceAttributes {
  const stored = parseStored(readRaw(APPEARANCE_KEYS.theme));
  const themePref =
    stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : (() => {
          const legacy = readRaw(LEGACY_THEME_KEY);
          return legacy === "light" || legacy === "dark" ? legacy : "system";
        })();
  const theme = themePref === "system" ? (systemDark ? "dark" : "light") : themePref;

  const oledOn = parseStored(readRaw(APPEARANCE_KEYS.oledMode)) === true;

  const accentRaw = parseStored(readRaw(APPEARANCE_KEYS.accentColor));
  const accent =
    typeof accentRaw === "string" &&
    (ACCENT_VALUES as readonly string[]).includes(accentRaw)
      ? accentRaw
      : "margin";

  return { theme, oled: oledOn && theme === "dark" ? "true" : "false", accent };
}
