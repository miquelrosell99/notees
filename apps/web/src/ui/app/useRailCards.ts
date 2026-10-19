/**
 * useRailCards — the right rail's peeked-page card stack (session state +
 * device-local order). Owns the stack state, the open/close/reorder
 * operations, the persistence effect (one write seam on every change, the
 * recents precedent), and the stale-id filtering on connect. The rail UI
 * itself renders in AppBody.
 */

import { useCallback, useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import { resolveAliasOpen } from "../components/aliasProperty.js";
import { moveRailCardOrder, persistRailCardOrder, readRailCardOrder } from "./railCardOrder.js";
import type { AnyClient } from "./clients.js";

export interface RailCards {
  sidebarCards: string[];
  setSidebarCards: Dispatch<SetStateAction<string[]>>;
  openInSidebar: (nodeId: string) => void;
  closeSidebarCard: (nodeId: string) => void;
  reorderSidebarCard: (activeId: string, targetId: string, position: "before" | "after") => void;
}

export function useRailCards(opts: {
  client: AnyClient | null;
  clientRef: RefObject<AnyClient | null>;
  setRightPanelOpen: Dispatch<SetStateAction<boolean>>;
}): RailCards {
  const { client, clientRef, setRightPanelOpen } = opts;
  /**
   * Right-sidebar peek cards (shift+click a block bullet): most recent first.
   * Re-clicking an open card brings it to the top; opening a card opens the
   * panel. Closing the last card closes the panel with it. The stack ORDER
   * is device-local (the recents-order precedent — `readRailCardOrder`): a
   * grip drag reorders it (the workspace drag session reports the gesture,
   * see useWorkspaceDnd), every change persists, and ids that no longer
   * exist in the current workspace are filtered out on connect.
   */
  const [sidebarCards, setSidebarCards] = useState<string[]>(() => readRailCardOrder());
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
  function closeSidebarCard(nodeId: string): void {
    const next = sidebarCards.filter((id) => id !== nodeId);
    setSidebarCards(next);
    if (next.length === 0) setRightPanelOpen(false);
  }
  /**
   * The rail reorder report (the workspace drag session's callback): a pure
   * stack move — no-ops return the same reference and never reach the
   * persistence effect.
   */
  const reorderSidebarCard = useCallback(
    (activeId: string, targetId: string, position: "before" | "after") => {
      setSidebarCards((prev) => moveRailCardOrder(prev, activeId, targetId, position));
    },
    [],
  );
  // The card order persists device-locally on every change (open, close,
  // reorder, stale-id filtering) — one write seam, the recents precedent.
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
  return { sidebarCards, setSidebarCards, openInSidebar, closeSidebarCard, reorderSidebarCard };
}
