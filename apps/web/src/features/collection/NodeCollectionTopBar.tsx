/**
 * NodeCollectionTopBar — the hosted collection's top chrome: the one row
 * that hosts the tabs strip (NodeCollectionTabs) and the filter toolbar
 * (NodeCollectionToolbar) side by side — tabs left (absorbing the free
 * width), toolbar cluster right. The toolbar rides with `layout="inline"`
 * (display: contents): its control row joins this row's flex line and its
 * structured panel takes a full-width wrapped line beneath it — render the
 * toolbar LAST in the slot so the wrap never moves the other controls.
 *
 * The composition is explicit slots, not an anonymous `trailing` passthrough:
 * the top bar NAMES the two parts every hosted collection's chrome is made
 * of. Small per-host extras that are not the toolbar (the view-chrome portal
 * target, the query node's view-mode switcher) ride NodeCollectionTabs' own
 * `trailing` slot or the toolbar slot's fragment — the tabs strip stays the
 * left cluster, everything right of it is the toolbar cluster.
 *
 * Alignment is `flex-start`: the toolbar row top-aligns with the tab row even
 * while the tabs strip carries its second manage row (rename/reorder/delete
 * for the selected custom tab) beneath it.
 */

import type { ReactNode } from "react";

import "./NodeCollectionTopBar.css";

export interface NodeCollectionTopBarProps {
  /** The tabs strip — NodeCollectionTabs. */
  tabs: ReactNode;
  /**
   * The toolbar cluster — NodeCollectionToolbar (layout="inline"), alone or
   * in a fragment with the host's right-cluster extras. Render it last so its
   * structured panel wraps beneath the row.
   */
  toolbar: ReactNode;
}

export function NodeCollectionTopBar({ tabs, toolbar }: NodeCollectionTopBarProps) {
  return (
    <div className="nt-node-collection-topbar">
      <div className="nt-node-collection-topbar__tabs">{tabs}</div>
      {toolbar}
    </div>
  );
}
