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
 * Ordering contract (the owner's register, ONE order shared by every
 * collection bar — the hub SurfaceTopBar and the hosted NodeCollectionTopBar
 * alike): the filter toolbar with its search field FIRST, then the chrome
 * slot, then the host's per-host controls (primary header actions), the
 * view switcher, and the "⋮ More actions" overflow last. The hosted
 * NodeCollection mounts the slot itself by default (slot FIRST); a host
 * passing a render-prop `toolbarContent` positions the slot inside its own
 * composition. Where a NodeCollectionToolbar's structured panel renders IN
 * PLACE (no host seat beneath the bar) the toolbar stays LAST in its
 * cluster — the panel wraps a full-width line beneath the row, and nothing
 * on the row may move when it does.
 */

import { createContext, useContext } from "react";

export const ViewChromeContext = createContext<HTMLElement | null>(null);

/** The hosted tab bar's view-chrome slot, or null outside a hosted row. */
export function useViewChromeTarget(): HTMLElement | null {
  return useContext(ViewChromeContext);
}

/**
 * ViewChromeSlot — the view-chrome portal target, mounted FIRST in every
 * controls cluster (the ordering contract: chrome slot, then the host's
 * per-host controls, NodeCollectionToolbar LAST so its structured panel's
 * wrapped line never moves the row's other controls). `display: contents`
 * merges the ported per-view toolbar into the cluster's flex line.
 *
 * The slot-element setter is a PROP because the owner differs per host: the
 * hosted NodeCollection owns the element, provides it to its own
 * ViewChromeContext, and renders the slot inside NodeCollectionTopBar's
 * cluster; the hub (CollectionHub) owns the element, renders the slot in
 * its SurfaceTopBar, and hands it DOWN as NodeCollection's `viewChromeTarget`
 * (the collection's own provider would clobber an outer one). One component
 * for both registers keeps the slot-first rule structural instead of a
 * comment convention.
 */
export function ViewChromeSlot({
  slotRef,
  className = "node-collection__view-chrome",
}: {
  /** The slot-element state setter (ref-callback) — the rendering host owns it. */
  slotRef: (element: HTMLSpanElement | null) => void;
  /** Host register override (the hub's seat CSS lives in CollectionHub.css). */
  className?: string | undefined;
}) {
  return <span className={className} ref={slotRef} />;
}
