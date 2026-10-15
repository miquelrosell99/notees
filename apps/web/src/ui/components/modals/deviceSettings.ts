/**
 * Device settings — the device-local persistence layer for settings that
 * have no server counterpart in this build.
 *
 * Everything lives under `notees.settings.*` in localStorage. Writes bump a
 * `notees-settings-changed` window event so every `useDeviceSetting` consumer
 * (a modal toggling a value, the Sidebar reading sidebar visibility) stays in
 * sync within the tab; the native `storage` event covers cross-tab sync.
 *
 * Appearance keys (theme / oled / accent) additionally drive `data-*`
 * attributes on <html>; index.html applies them before first paint so there
 * is no flash on reload.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { resolveAppearanceAttributes } from "../../appearance.js";

export const DEVICE_SETTINGS_PREFIX = "notees.settings.";

const SETTINGS_CHANGED_EVENT = "notees-settings-changed";

function storageKey(settingKey: string): string {
  return `${DEVICE_SETTINGS_PREFIX}${settingKey}`;
}

export function readDeviceSetting<T>(settingKey: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(storageKey(settingKey));
    if (raw === null) return defaultValue;
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

export function writeDeviceSetting<T>(settingKey: string, value: T): void {
  try {
    localStorage.setItem(storageKey(settingKey), JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode); the setting just won't persist.
  }
  window.dispatchEvent(
    new CustomEvent<{ key: string }>(SETTINGS_CHANGED_EVENT, { detail: { key: settingKey } }),
  );
}

/**
 * useDeviceSetting — state-backed access to a device setting. The returned
 * setter persists and notifies; `storage` / custom events re-read the value
 * when it changes anywhere else (another component, another tab).
 */
export function useDeviceSetting<T>(
  settingKey: string,
  defaultValue: T,
): [T, (value: T) => void] {
  const defaultRef = useRef(defaultValue);
  defaultRef.current = defaultValue;

  const [value, setValue] = useState<T>(() => readDeviceSetting(settingKey, defaultValue));

  useEffect(() => {
    const sync = () => setValue(readDeviceSetting(settingKey, defaultRef.current));
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [settingKey]);

  const set = useCallback(
    (next: T) => {
      writeDeviceSetting(settingKey, next);
      setValue(next);
    },
    [settingKey],
  );

  return [value, set];
}

// --- Appearance (theme / OLED / accent / font) ----------------------------------

export type ThemePreference = "light" | "dark" | "system";
export type AccentColor = "margin" | "monochrome" | "brown" | "teal" | "blue";
/** The UI font family: bundled (Instrument Sans/Newsreader/JetBrains Mono,
 * self-hosted in fonts.css) or the platform system stack. */
export type UiFontPreference = "bundled" | "system";

/** The curated accent presets: brand green as the default, monochrome, and
 * three curated hues. The hex is the light-mode value, also used for the
 * settings swatch previews; dark-mode variants live in variables.css. */
export const ACCENT_COLOR_OPTIONS: { value: AccentColor; label: string; hex: string }[] = [
  { value: "margin", label: "Advance Green", hex: "#2e5e46" },
  { value: "monochrome", label: "Monochrome", hex: "#1c1a16" },
  { value: "brown", label: "Brown", hex: "#a16b45" },
  { value: "teal", label: "Teal", hex: "#1fbdad" },
  { value: "blue", label: "Blue", hex: "#3d6a96" },
];

export function isValidHexColor(hex: string): boolean {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex);
}

/** Contrast text color for a hex background (3- or 6-digit). */
export function getContrastColor(hex: string): "#000000" | "#ffffff" {
  const normalized = hex.replace("#", "");
  const full =
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized;
  if (!/^[0-9A-Fa-f]{6}$/.test(full)) return "#ffffff";
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000000" : "#ffffff";
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Resolve a theme preference (incl. "system") to the concrete dataset value. */
export function resolveTheme(theme: ThemePreference): "light" | "dark" {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

/**
 * applyAppearance — push the persisted appearance settings onto <html>.
 * Theme resolution honors "system" live; OLED only applies to the dark theme
 * (pure-black overrides exist for dark surfaces only). The theme/OLED/accent
 * trio resolves in src/ui/appearance.ts — the index.html pre-paint bootstrap
 * mirrors it, and a parity test gates the two against each other.
 */
export function applyAppearance(): void {
  if (typeof document === "undefined") return;
  const attrs = resolveAppearanceAttributes(
    (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    systemPrefersDark(),
  );
  document.documentElement.dataset.theme = attrs.theme;
  document.documentElement.dataset.oled = attrs.oled;
  document.documentElement.dataset.accent = attrs.accent;

  // The UI font rides the same pre-paint data-attribute path.
  const uiFont = readDeviceSetting<UiFontPreference>("uiFont", "bundled");
  document.documentElement.dataset.font = uiFont;

  // Focus mode (#12): dims the shell chrome (topbar / sidebar / right rail)
  // while the page card stays full strength. Device-local display state.
  const focusMode = readDeviceSetting("focusMode", false);
  document.documentElement.dataset.focus = focusMode ? "true" : "false";
}

/**
 * Toggle focus mode (#12) — flips the device setting, re-applies the
 * data-attribute, and returns the new state. Shared by the command palette
 * command and the App chord; `writeDeviceSetting`'s broadcast keeps every
 * `useDeviceSetting` consumer in sync.
 */
export function toggleFocusMode(): boolean {
  const next = !readDeviceSetting("focusMode", false);
  writeDeviceSetting("focusMode", next);
  applyAppearance();
  return next;
}

/**
 * Flip theme — the palette's "Toggle theme" command. Flips what's ON SCREEN
 * (the resolved `data-theme`, the same source the command's label names —
 * "switch to light" must land on light) and stores the opposite as an
 * explicit preference, so the flip always sticks on reload (the palette's
 * old private writer set the legacy key, which the modern setting
 * overrides — a no-op flip). The OLED flag rides the dark theme and
 * survives a light→dark round trip.
 */
export function flipTheme(): "light" | "dark" {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next: ThemePreference = current === "dark" ? "light" : "dark";
  writeDeviceSetting("theme", next);
  applyAppearance();
  return next;
}
