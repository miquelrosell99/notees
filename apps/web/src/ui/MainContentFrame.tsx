/**
 * MainContentFrame — the panelled main-content composition generalized
 * (owner 2026-10-23): the layout the node view alone used to own — a
 * full-width top bar above a three-column body (raised-card panel left ·
 * content middle · raised-card panel right) — becomes a shared, purely
 * presentational component any main-content view composes. PageView was the
 * first host (its context column and properties sidebar moved out of
 * PageView's private grid into the frame's slots); CalendarView is the
 * second (its mini-month + week strip + week agenda ride the right panel,
 * toggled from the top bar). Any other main-content view opts in the same
 * way — that opt-in IS the flag: a view renders the frame and passes panel
 * content, or doesn't and renders full-bleed.
 *
 * The frame owns NO state: whether a panel renders is the host's call (its
 * own device-local collapse prefs, its own focus mode), communicated by
 * passing the panel ReactNode or undefined. Each host owns its panel CONTENT
 * too — the frame supplies only the chrome registers (the card element, the
 * column split, the collapse geometry), so two hosts never share panel
 * content, only the composition.
 *
 * The CSS registers move with the frame (MainContentFrame.css): the panel
 * cards keep their class names (.nt-page-context / .nt-page-side-panel —
 * the raised-card panel registers documented there), the body row is
 * .nt-main-frame__body, the middle cell .nt-main-frame__content carries NO
 * width cap — the host wraps its children in its own cap when it wants one
 * (PageView's journal measure, .nt-page-content in app.css) and rides
 * full-bleed when it doesn't (the hubs' eventual panel adoption).
 */

import type { ReactNode } from "react";

import "./MainContentFrame.css";

export interface MainContentFrameProps {
  /**
   * The full-width bar pinned above the column split — any SurfaceTopBar
   * composition (the nodeview top bar, a hub bar). The bar never rescales
   * when a panel shows or hides: it rides above the columns, not inside
   * one.
   */
  topBar: ReactNode;
  /** The left panel's content; undefined renders no left column. */
  leftPanel?: ReactNode;
  /** The left panel card's accessible name (the context column default). */
  leftLabel?: string;
  /** The right panel's content; undefined renders no right column. */
  rightPanel?: ReactNode;
  /** The right panel card's accessible name (the properties default). */
  rightLabel?: string;
  /** The middle column: the view's own body (scroller, cap, chrome). */
  children: ReactNode;
}

export function MainContentFrame({
  topBar,
  leftPanel,
  leftLabel = "Context",
  rightPanel,
  rightLabel = "Properties",
  children,
}: MainContentFrameProps) {
  return (
    <div className="nt-main-frame">
      {topBar}
      <div className="nt-main-frame__body">
        {leftPanel !== undefined && (
          <aside className="nt-page-context" aria-label={leftLabel}>
            {leftPanel}
          </aside>
        )}
        <div className="nt-main-frame__content">{children}</div>
        {rightPanel !== undefined && (
          <aside className="nt-page-side-panel" aria-label={rightLabel}>
            {rightPanel}
          </aside>
        )}
      </div>
    </div>
  );
}
