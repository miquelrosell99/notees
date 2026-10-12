/**
 * ViewChromeContext — the hosted tab bar's view-chrome portal seam (owner
 * 2026-10-12). A hosted NodeCollection renders an empty slot element inside
 * the tab bar's right-hand cluster and provides it here; a view that owns
 * per-view chrome (the table's columns/sort/more row, the cards/board
 * selection + cover-layout row) portals that chrome INTO the slot when a
 * target exists, and renders it in place above the view otherwise (the
 * un-hosted hubs and sections keep the body-top row). The views keep their
 * chrome's state — the portal teleports only the rendering.
 *
 * Ordering contract: NodeCollection mounts the slot BEFORE the host's
 * `tabBarTrailing`, and the host ends the cluster with the FilterBar — the
 * FilterBar's structured panel wraps a full-width line beneath the row, and
 * nothing on the row may move when it does.
 */

import { createContext, useContext } from "react";

export const ViewChromeContext = createContext<HTMLElement | null>(null);

/** The hosted tab bar's view-chrome slot, or null outside a hosted row. */
export function useViewChromeTarget(): HTMLElement | null {
  return useContext(ViewChromeContext);
}
