/**
 * ThemeToggle — flips the app between the dark (default) and light themes.
 *
 * Reads/writes `data-theme` on <html> and persists the choice in
 * localStorage under "notees.theme"; index.html applies the stored choice
 * before first paint so there is no theme flash on reload.
 */

import { useState } from "react";

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
      className="nt-theme-toggle"
      title="Toggle theme"
      aria-label="Toggle theme"
      onClick={toggle}
    >
      {theme === "dark" ? "\u263E" : "\u2600"}
    </button>
  );
}
