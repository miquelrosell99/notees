/**
 * useSidePanel + SidePanelToggle — the hub side-panel + top-bar toggle as
 * ONE unit (owner 2026-10-27: "link both elements at the component level —
 * enabling the sidebar enables the corresponding button, correctly
 * positioned"). A hub declares the panel's SIDE once; the toggle's
 * position, icon, and pressed state derive from it, so the toggle can
 * never drift to the opposite end of the bar from the panel it drives
 * (the Journal hub's regression this replaces: the toggle led the bar,
 * left of the title, while the panel rendered in the body's right column).
 *
 *  - `useSidePanel` — the full pair for hosts that render the panel
 *    locally: returns `toggle` (pass into SurfaceTopBar's `leading`
 *    (side "left") or `trailing` (side "right")) and `panel` (the `<aside>`
 *    landmark, null while closed). The host owns the panel's layout CSS via
 *    `className` (flex-basis, borders — the journal's `.journals-panel`
 *    register); this component adds no visual opinion of its own.
 *  - `SidePanelToggle` — the toggle alone, for hosts whose panel container
 *    lives elsewhere (SourcesHub's panes ride MainContentFrame's
 *    leftPanel/rightPanel slots; the app TopBar's sidebars render in the
 *    App shell). The side → slot wiring stays the host's one-line choice;
 *    the chrome contract (ghost sm, dock icon, aria-pressed = the panel's
 *    EFFECTIVE visibility, Show/Hide {label} wording) is centralized here.
 *
 * Both ride the same chrome: the dock icon reads the side (mdi-dock-left /
 * mdi-dock-right, the SourcesHub precedent). Collapse state stays a host
 * device-setting (the journals register) — these components are the
 * wiring, not the state.
 */

import type { ReactNode } from "react";

import { Button } from "./Button.js";

export interface SidePanelToggleProps {
  /** The panel's side — the host places the toggle in the top-bar slot on the SAME side. */
  side: "left" | "right";
  /** The panel's EFFECTIVE visibility — drives the pressed/active chrome. */
  open: boolean;
  onToggle: () => void;
  /** The noun in the toggle's labels — "Show {label}" / "Hide {label}". */
  label: string;
  /**
   * The state the LABELS report — defaults to `open`. SourcesHub's detail
   * toggle splits the two deliberately: the label reports the stored PREF
   * (Hide/Show per the device setting) while the pressed/active chrome
   * reports EFFECTIVE visibility (the pref AND a selection — the shipped
   * contract the sources tests pin).
   */
  labelOpen?: boolean | undefined;
}

/** The hub side-panel toggle: one chrome contract, the side on its face. */
export function SidePanelToggle({ side, open, onToggle, label, labelOpen }: SidePanelToggleProps): ReactNode {
  const toggleLabel = `${(labelOpen ?? open) ? "Hide" : "Show"} ${label}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      icon={side === "left" ? "mdi-dock-left" : "mdi-dock-right"}
      aria-label={toggleLabel}
      aria-pressed={open}
      title={toggleLabel}
      active={open}
      onClick={onToggle}
    />
  );
}

export interface SidePanelConfig {
  /** The panel's side — the toggle rides the top-bar slot on the SAME side. */
  side: "left" | "right";
  /** The panel's EFFECTIVE visibility (drives the toggle's pressed state and the panel's render). */
  open: boolean;
  onToggle: () => void;
  /** The noun in the toggle's labels — "Show {label}" / "Hide {label}". */
  label: string;
  /** The aside's landmark label; defaults to `label`. */
  panelLabel?: string | undefined;
  /** Extra class on the aside (the host's layout register). */
  className?: string | undefined;
  children: ReactNode;
}

export interface SidePanelSlots {
  /** The toggle Button — SurfaceTopBar's `leading` (left) or `trailing` (right). */
  toggle: ReactNode;
  /** The panel aside — null while closed. */
  panel: ReactNode;
}

/** The full linked pair for hosts rendering the panel in their own body. */
export function useSidePanel({
  side,
  open,
  onToggle,
  label,
  panelLabel,
  className,
  children,
}: SidePanelConfig): SidePanelSlots {
  const toggle = <SidePanelToggle side={side} open={open} onToggle={onToggle} label={label} />;
  const panel = open ? (
    <aside className={["fleet-side-panel", className].filter(Boolean).join(" ")} aria-label={panelLabel ?? label}>
      {children}
    </aside>
  ) : null;
  return { toggle, panel };
}
