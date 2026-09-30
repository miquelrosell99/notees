/**
 * ThemeToggle — flips the app between the dark (default) and light themes.
 *
 * Reads/writes `data-theme` on <html> and persists the choice in
 * localStorage under "notees.theme"; index.html applies the stored choice
 * before first paint so there is no theme flash on reload. Rendered as a
 */

import { useState } from "react";

import { Icon } from "./Icon.js";

const THEME_KEY = "notees.theme";

type Theme = "dark" | "light";

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
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
