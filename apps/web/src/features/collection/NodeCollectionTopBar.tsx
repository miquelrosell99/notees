/**
 * NodeCollectionTopBar — the hosted collection's top chrome: the one row
 * that hosts the tabs strip (NodeCollectionTabs) and the filter toolbar
 * (NodeCollectionToolbar) side by side — tabs left (absorbing the free
 * width), toolbar cluster right. The toolbar rides with `layout="inline"`
 * (display: contents): its control row joins this row's flex line and its
 * structured panel PORTALS into the bar's own full-width slot beneath the
 * row — the cluster is width-capped (a mini-column at the bar's right edge),
 * so a panel that wrapped inside it would squeeze into the cap instead of
 * spanning the bar side to side. (Without such a seat the toolbar renders
 * its panel IN PLACE and must ride LAST in its cluster — the wrapped
 * full-width line never moves the row's other controls.)
 *
 * The composition is explicit slots, not an anonymous `trailing` passthrough:
 * the top bar NAMES the parts every hosted collection's chrome is made
 * of. Small per-host extras that are not the toolbar (the view-chrome portal
 * target, the query node's view-mode switcher) ride the toolbar slot's
 * fragment — the tabs strip stays the left cluster, everything right of it
 * is the toolbar cluster, ordered by the shared register (viewChrome.tsx).
 *
 * Alignment is `flex-start`: the toolbar row top-aligns with the tab row even
 * while the tabs strip carries its second manage row (rename/reorder/delete
 * for the selected custom tab) beneath it.
 */

import { createContext, useContext, useState, type ReactNode } from "react";

import "./NodeCollectionTopBar.css";

/**
 * The structured panel's full-width seat: the bar's LAST child, a
 * `display: contents` element whose children flex against the BAR (not the
 * capped cluster). The inline NodeCollectionToolbar portals its panel here;
 * null while no topbar hosts the toolbar (the hub-cards host renders the
 * panel in place) and on the very first render (the ref lands before paint,
 * so the portal never flashes in the wrong seat).
 *
 * Exported raw (the ViewChromeContext precedent): the hub shell
 * (CollectionHub) provides the same context around its own SurfaceTopBar
 * panel seat — every host of an inline NodeCollectionToolbar names the same
 * seat contract.
 */
export const PanelHostContext = createContext<HTMLElement | null>(null);

/** The panel seat an inline NodeCollectionToolbar portals its panel into. */
export function useNodeCollectionTopBarPanelHost(): HTMLElement | null {
  return useContext(PanelHostContext);
}

export interface NodeCollectionTopBarProps {
  /** The tabs strip — NodeCollectionTabs. */
  tabs: ReactNode;
  /**
   * The toolbar cluster — NodeCollectionToolbar (layout="inline"), alone or
   * in a fragment with the host's right-cluster extras (the view-chrome
   * portal target). Everything here renders inside ONE right-justified
   * cluster — never as sibling flex items beside a grown toolbar row.
   */
  toolbar: ReactNode;
}

export function NodeCollectionTopBar({ tabs, toolbar }: NodeCollectionTopBarProps) {
  const [panelHost, setPanelHost] = useState<HTMLElement | null>(null);
  return (
    <PanelHostContext.Provider value={panelHost}>
      <div className="nt-node-collection-topbar">
        <div className="nt-node-collection-topbar__tabs">{tabs}</div>
        <div className="nt-node-collection-topbar__cluster">{toolbar}</div>
        <div className="nt-node-collection-topbar__panel-host" ref={setPanelHost} />
      </div>
    </PanelHostContext.Provider>
  );
}
