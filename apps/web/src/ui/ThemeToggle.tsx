/**
 * ThemeToggle — flips the app between the dark (default) and light themes.
 *
 * The single writer seam is the device-settings layer
 * (`writeDeviceSetting("theme", …)` + `applyAppearance()`): the data
 * attributes, the OLED guard, the `notees-settings-changed` broadcast (so
 * Settings → Appearance re-syncs), and persistence all stay consistent.
 * Flipping from "system" picks the opposite of the currently resolved theme.
 */

import { applyAppearance, resolveTheme, useDeviceSetting, writeDeviceSetting, type ThemePreference } from "./components/modals/deviceSettings.js";

import { Icon } from "./Icon.js";

export function ThemeToggle() {
  const [theme] = useDeviceSetting<ThemePreference>("theme", "system");
  const resolved = resolveTheme(theme);

  const toggle = () => {
    const next: ThemePreference = resolved === "dark" ? "light" : "dark";
    writeDeviceSetting("theme", next);
    applyAppearance();
  };

  return (
    <button
      type="button"
      className="nt-icon-btn"
      title={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      aria-label="Toggle theme"
      onClick={toggle}
    >
      <Icon path={resolved === "dark" ? "mdi-weather-night" : "mdi-white-balance-sunny"} size={1} />
    </button>
  );
}
