/**
 * PageCard — the ONE floating content card of the shell. The background
 * canvas hosts the chrome directly; the main view renders inside this
 * single card: surface fill, hairline outline-variant border, large radius,
 * a soft layered elevation shadow, centered at min(960px, 100% − 48px),
 * tall as the viewport minus the topbar minus ~20px margins, scrolling
 * internally. Extracted from App.tsx/app.css.
 */

import type { ReactNode } from "react";
import "./PageCard.css";

export function PageCard({ children }: { children: ReactNode }) {
  return (
    <main className="nt-main">
      <div className="nt-page-card">{children}</div>
    </main>
  );
}
