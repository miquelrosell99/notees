/**
 * HistoryMenuPopup — the history menu with jump-to: a
 * browsable popup over the session undo journal's bounded
 * stack. Every entry renders its label ("Undo edit text") and timestamp,
 * NEWEST first; clicking an entry JUMPS — it opens the first affected node
 * that still resolves (for text entries that is plain navigation; the
 * journal cannot restore a past caret, and it doesn't pretend to). Entries
 * whose nodes are all gone render disabled, honestly. The popup opens from
 * the topbar undo button's chevron or Ctrl/Cmd+Shift+H, closes on the
 * standard dismissal convention (usePopupDismissal), and re-reads the journal on every
 * client notification while open — the list is always live.
 */

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";
import type { UndoHistoryEntry } from "@/core/undo-journal.js";

import { Icon } from "../Icon.js";
import { useViewportFlip } from "./ui/overlay-hooks.js";
import { usePopupDismissal } from "./ui/usePopupDismissal.js";
import "./HistoryMenuPopup.css";

type AnyClient = WorkspaceClient | WorkerClient;

export function HistoryMenuPopup({
  client,
  isOpen,
  onClose,
  anchorRef,
  onOpenNode,
}: {
  client: AnyClient;
  isOpen: boolean;
  onClose: () => void;
  /** The topbar undo cluster's chevron button. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Jump target: open the affected node (plain navigation). */
  onOpenNode: (nodeId: string) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<UndoHistoryEntry[] | null>(null);
  /** Notification version — re-reads the journal while open. */
  const [version, setVersion] = useState(0);

  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void Promise.resolve(client.undoHistory()).then((history) => {
      if (!cancelled) setEntries(history);
    });
    return () => {
      cancelled = true;
    };
    // `version` re-reads on every notification while open.
  }, [isOpen, client, version]);

  const position = useViewportFlip(anchorRef, isOpen, {
    popupRef,
    popupHeight: 320,
    fixed: true,
  });

  usePopupDismissal({
    popupRef,
    anchorRefs: [anchorRef],
    isOpen,
    onClose,
  });

  if (!isOpen) return null;

  const style: CSSProperties = position
    ? { top: position.top, left: position.left, visibility: "visible" }
    : { visibility: "hidden" };

  /** The first affected id that still resolves — the jump target (or null). */
  const jumpTargetOf = (entry: UndoHistoryEntry): string | null => {
    for (const id of entry.affected) {
      if (client.getNode(id) !== undefined) return id;
    }
    return null;
  };

  // Browsable history reads forward-in-time; the journal hands oldest-first,
  // so the menu reverses — the newest gesture rides the top.
  const rows = entries === null ? [] : [...entries].reverse();

  return (
    <div
      className="history-popup"
      role="menu"
      aria-label="History"
      ref={popupRef}
      style={style}
    >
      <div className="history-popup__title">History</div>
      {rows.length === 0 ? (
        <div className="history-popup__empty">Nothing to undo yet — edits you make land here.</div>
      ) : (
        <ul className="history-popup__list">
          {rows.map((entry, index) => {
            const target = jumpTargetOf(entry);
            const time = new Date(entry.at).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            });
            return (
              <li key={`${entry.at}-${index}`}>
                <button
                  type="button"
                  role="menuitem"
                  className="history-popup__row"
                  disabled={target === null}
                  title={
                    target !== null
                      ? "Open the affected node"
                      : "The affected node no longer exists"
                  }
                  onClick={() => {
                    if (target === null) return;
                    onClose();
                    onOpenNode(target);
                  }}
                >
                  <Icon path="mdi-undo-variant" size={0.8} className="history-popup__row-icon" />
                  <span className="history-popup__row-label">{`Undo ${entry.verb}`}</span>
                  <span className="history-popup__row-time">{time}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="history-popup__hint">Ctrl+Shift+H · click a row to jump to it</div>
    </div>
  );
}
