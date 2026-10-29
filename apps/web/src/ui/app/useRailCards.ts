/**
 * useRailCards — the right rail's peeked-node card stack (session state +
 * device-local recency order). Owns the stack state, the open/close and
 * collapse-stack operations, the persistence effect (one write seam on every
 * change, the recents precedent), and the stale-id filtering on connect.
 * The rail UI itself renders in AppBody.
 */

import { useCallback, useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import { resolveAliasOpen } from "../../features/metadata/aliasProperty.js";
import { persistRailCardOrder, readRailCardOrder } from "./railCardOrder.js";
import type { AnyClient } from "./clients.js";

export interface RailCards {
  sidebarCards: string[];
  openInSidebar: (nodeId: string) => void;
  closeSidebarCard: (nodeId: string) => void;
  closeOtherSidebarCards: (nodeId: string) => void;
  closeAllSidebarCards: () => void;
  collapsedCards: ReadonlySet<string>;
  toggleSidebarCardCollapsed: (nodeId: string) => void;
  collapseOtherSidebarCards: (nodeId: string) => void;
  collapseAllSidebarCards: () => void;
  expandAllSidebarCards: () => void;
}

export function useRailCards(opts: {
  client: AnyClient | null;
  clientRef: RefObject<AnyClient | null>;
  setRightPanelOpen: Dispatch<SetStateAction<boolean>>;
}): RailCards {
  const { client, clientRef, setRightPanelOpen } = opts;
  /**
   * Right-sidebar peek cards (shift+click a block bullet): most recent first.
   * A node renders as a SINGLE card instance — re-peeking a carded node
   * moves its card to the top of the stack, never duplicates it. There is no
   * reorder gesture: the stack order IS the recency of peeks (the one write
   * seam persists it device-locally, the recents-order precedent —
   * `readRailCardOrder`). Opening a card opens the panel; closing the last
   * card closes the panel with it. Ids that no longer exist in the current
   * workspace are filtered out on connect.
   */
  const [sidebarCards, setSidebarCards] = useState<string[]>(() => readRailCardOrder());
  /**
   * The collapsed card set (session-local card management — display state,
   * never an op, never persisted). A collapsed card hides its body; the
   * header bar stays. Closed ids are pruned so the set never outlives the
   * stack.
   */
  const [collapsedCards, setCollapsedCards] = useState<ReadonlySet<string>>(new Set());
  const openInSidebar = useCallback(
    (nodeId: string) => {
      // The redirect seam: a peek card opened on an alias shows the
      // terminal's card (the same resolution openPage applies).
      const live = clientRef.current;
      const resolved = live !== null ? resolveAliasOpen(live, nodeId) : nodeId;
      setSidebarCards((prev) => [resolved, ...prev.filter((id) => id !== resolved)]);
      setRightPanelOpen(true);
    },
    [clientRef, setRightPanelOpen],
  );
  const closeSidebarCard = useCallback((nodeId: string) => {
    setSidebarCards((prev) => {
      const next = prev.filter((id) => id !== nodeId);
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setCollapsedCards((prev) => {
      if (!prev.has(nodeId)) return prev;
      const next = new Set(prev);
      next.delete(nodeId);
      return next;
    });
  }, [setRightPanelOpen]);
  const closeOtherSidebarCards = useCallback((nodeId: string) => {
    setSidebarCards((prev) => {
      const next = prev.filter((id) => id === nodeId);
      if (next.length === 0) setRightPanelOpen(false);
      return next;
    });
    setCollapsedCards(new Set());
  }, [setRightPanelOpen]);
  const closeAllSidebarCards = useCallback(() => {
    setSidebarCards([]);
    setCollapsedCards(new Set());
    setRightPanelOpen(false);
  }, [setRightPanelOpen]);
  const toggleSidebarCardCollapsed = useCallback((nodeId: string) => {
    setCollapsedCards((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);
  const collapseOtherSidebarCards = useCallback((nodeId: string) => {
    setCollapsedCards(new Set([nodeId]));
  }, []);
  const collapseAllSidebarCards = useCallback(() => {
    setCollapsedCards(new Set(sidebarCards));
  }, [sidebarCards]);
  const expandAllSidebarCards = useCallback(() => {
    setCollapsedCards(new Set());
  }, []);
  // The card order persists device-locally on every change (open, close,
  // stale-id filtering) — one write seam, the recents precedent.
  useEffect(() => {
    persistRailCardOrder(sidebarCards);
  }, [sidebarCards]);
  // The persisted rail order may carry ids from another workspace (the key
  // is device-global, the recents precedent): drop the ones this client
  // doesn't know — the persistence effect writes the filtered list through.
  useEffect(() => {
    if (client === null) return;
    setSidebarCards((prev) => {
      const next = prev.filter((id) => client.getNode(id) !== undefined);
      return next.length === prev.length ? prev : next;
    });
  }, [client]);
  return {
    sidebarCards,
    openInSidebar,
    closeSidebarCard,
    closeOtherSidebarCards,
    closeAllSidebarCards,
    collapsedCards,
    toggleSidebarCardCollapsed,
    collapseOtherSidebarCards,
    collapseAllSidebarCards,
    expandAllSidebarCards,
  };
}
