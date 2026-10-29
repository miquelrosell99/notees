/**
 * ViewChromeContext — the view-chrome portal seam. A hosted NodeCollection renders an empty slot element inside
 * the tab bar's right-hand cluster and provides it here; a view that owns
 * per-view chrome (the table's columns/sort/more row, the cards/board
 * selection + cover-layout row, the outline's sort button) portals that chrome INTO the slot when a
 * target exists, and renders it in place above the view otherwise (the
 * body-top row). The hub shell mounts the same kind of slot inside its
 * SurfaceTopBar's actions cluster and hands it down as NodeCollection's
 * `viewChromeTarget` (the collection's own provider would clobber an outer
 * one, so the host passes the element through the prop). The views keep their
 * chrome's state — the portal teleports only the rendering.
 *
 * Ordering contract: NodeCollection mounts the slot BEFORE the host's
 * `tabBarTrailing`, and the host ends the cluster with the NodeCollectionToolbar — the
 * NodeCollectionToolbar's structured panel wraps a full-width line beneath the row, and
 * nothing on the row may move when it does.
 */

import { createContext, useContext } from "react";

export const ViewChromeContext = createContext<HTMLElement | null>(null);

/** The hosted tab bar's view-chrome slot, or null outside a hosted row. */
export function useViewChromeTarget(): HTMLElement | null {
  return useContext(ViewChromeContext);
}
