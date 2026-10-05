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
export type AccentColor = "monochrome" | "sage" | "teal" | "rose" | "navy" | "custom";
/** §34.96 (#6) — the UI font family: bundled (Inter/JetBrains Mono,
 * self-hosted in fonts.css) or the platform system stack. */
export type UiFontPreference = "bundled" | "system";

export const ACCENT_COLOR_OPTIONS: { value: AccentColor; label: string; hex: string }[] = [
  { value: "monochrome", label: "Monochrome", hex: "#404040" },
  { value: "sage", label: "Sage", hex: "#527051" },
  { value: "teal", label: "Teal", hex: "#2D6B5B" },
  { value: "rose", label: "Rose", hex: "#8B5B5B" },
  { value: "navy", label: "Navy", hex: "#1E3A5F" },
];

/** Legacy key the theme used to live under; read as a fallback on migration. */
const LEGACY_THEME_KEY = "notees.theme";

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
 * (pure-black overrides exist for dark surfaces only).
 */
export function applyAppearance(): void {
  if (typeof document === "undefined") return;
  const stored = readDeviceSetting<ThemePreference | null>("theme", null);
  const legacy = (() => {
    try {
      return localStorage.getItem(LEGACY_THEME_KEY);
    } catch {
      return null;
    }
  })();
  const theme: ThemePreference =
    stored ?? (legacy === "light" || legacy === "dark" ? legacy : "system");
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  const oled = readDeviceSetting("oledMode", false);
  document.documentElement.dataset.oled = oled && resolved === "dark" ? "true" : "false";

  const accent = readDeviceSetting<AccentColor>("accentColor", "monochrome");
  document.documentElement.dataset.accent = accent;

  // §34.96 (#6): the UI font rides the same pre-paint data-attribute path.
  const uiFont = readDeviceSetting<UiFontPreference>("uiFont", "bundled");
  document.documentElement.dataset.font = uiFont;
  if (accent === "custom") {
    const hex = readDeviceSetting("customAccentHex", "#404040");
    if (isValidHexColor(hex)) {
      document.documentElement.style.setProperty("--color-accent-custom", hex);
      document.documentElement.style.setProperty(
        "--color-on-accent-custom",
        getContrastColor(hex),
      );
    }
  }
}
