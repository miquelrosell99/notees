/**
 * PageCard — the ONE floating content card of the shell. The background
 * canvas hosts the chrome directly; the main view renders inside this
 * single card: surface fill, hairline outline-variant border, large radius,
 * a soft layered elevation shadow, centered at min(960px, 100% − 48px),
 * tall as the viewport minus the topbar minus ~20px margins, scrolling
 * internally. Extracted from App.tsx/app.css.
 */

import type { ReactNode } from "react";
import { cssColorFor } from "./ui/colorPresets.js";
import "./PageCard.css";

/** The ONE floating content card; `accent` paints the node-color left border. */
export function PageCard({ children, accent }: { children: ReactNode; accent?: string | null }) {
  return (
    <main className="nt-main">
      <div
        className={accent !== null && accent !== undefined ? "nt-page-card has-node-border" : "nt-page-card"}
        style={
          accent !== null && accent !== undefined
            ? { borderLeft: "3px solid", borderLeftColor: cssColorFor(accent) }
            : undefined
        }
      >
        {children}
      </div>
    </main>
  );
}
