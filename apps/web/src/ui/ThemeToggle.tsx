/**
 * ThemeToggle — flips the app between the dark (default) and light themes.
 *
 * Reads/writes the device-local setting (`notees.settings.theme`) and
 * applies `data-theme` on <html>; index.html applies the stored choice
 * before first paint so there is no theme flash on reload. Flipping from
 * "system" picks the opposite of the currently resolved theme.
 */

import { useState } from "react";

import { Icon } from "./Icon.js";

function currentTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">(currentTheme);

  const toggle = () => {
    const next: "dark" | "light" = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("notees.settings.theme", JSON.stringify(next));
    } catch {
      // Storage unavailable; the flip just won't persist.
    }
    setTheme(next);
  };

  return (
    <button
      type="button"
      className="nt-icon-btn"
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      aria-label="Toggle theme"
      onClick={toggle}
    >
      <Icon path={theme === "dark" ? "mdi-weather-night" : "mdi-white-balance-sunny"} size={1} />
    </button>
  );
}
