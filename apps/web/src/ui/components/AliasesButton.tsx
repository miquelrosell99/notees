/**
 * AliasesButton — the title-row affordance on the ALIASED node's page
 * (SCHEMA.md "Node aliases"): a small count/button next to the title
 * ("Aliases · N") opening the aliases list — every live page whose
 * alias-terminal is this node (chains included, via the client's
 * aliasNodesOf read over the `aliased_node_id` column).
 *
 * Each row names the alias and carries a NAVIGATE button that opens the
 * ALIAS node's OWN NodeView — the one deliberate bypass of the universal
 * redirect (from there the alias renders as a normal node view with its
 * own references, and the "Alias of …" banner jumps back).
 *
 * ADD opens the node picker (pages only) and writes THE SELECTED node's
 * `aliasedNodeId` to the ACTIVE node — the backward write, never the
 * active node's own field (the main page holds nothing; the relation is
 * one-way FROM the alias). The picker filters out nodes whose
 * `aliasedNodeId` is already set and the active node itself (a self-alias
 * is a write-time cycle — the applier would fail it loud), and the
 * page-restriction guard validates the pick before writing.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { usePopupDismissal } from "./ui/usePopupDismissal.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import { aliasedNodeTargetError } from "./aliasProperty.js";
import { flipOverlayTop, clampOverlayLeft } from "../editor-popups/overlay-position.js";
import "./AliasesButton.css";

type AnyClient = WorkspaceClient | WorkerClient;

const POPUP_GAP = 4;
const VIEWPORT_PADDING = 8;

export function AliasesButton({
  client,
  nodeId,
  onOpenPageRaw,
}: {
  client: AnyClient;
  nodeId: string;
  /** The RAW open — bypasses the alias redirect so the alias's OWN view renders. */
  onOpenPageRaw: (pageId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);

  // Freshness: the cached aliasNodesOf read converges via the client's
  // change notification — bump a version to re-render the count and list.
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const aliases = client.aliasNodesOf(nodeId);

  usePopupDismissal({
    popupRef,
    anchorRefs: [buttonRef],
    isOpen: open && !adding,
    onClose: () => setOpen(false),
  });

  // Position: fixed at the trigger, flip above when no room, clamped.
  useLayoutEffect(() => {
    const floating = popupRef.current;
    if (floating === null || !open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    const update = () => {
      if (rect === undefined) {
        floating.style.visibility = "visible";
        return;
      }
      const { top, placement } = flipOverlayTop(
        { top: rect.bottom, bottom: rect.bottom, left: rect.left },
        floating.offsetHeight,
        POPUP_GAP,
        VIEWPORT_PADDING,
      );
      floating.style.left = `${clampOverlayLeft(rect.left, floating.offsetWidth, VIEWPORT_PADDING)}px`;
      floating.style.top = `${placement === "above" ? rect.top - floating.offsetHeight - POPUP_GAP : top}px`;
      floating.style.visibility = "visible";
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [open, aliases.length]);

  /**
   * THE backward write: the picked node's `aliasedNodeId` becomes the
   * ACTIVE node — never the other way around.
   */
  const addAlias = async (pickedId: string): Promise<void> => {
    const targetError = aliasedNodeTargetError(client, pickedId);
    if (targetError !== null) {
      setError(targetError);
      return;
    }
    await client.updateObject(pickedId, { aliasedNodeId: nodeId });
    setAdding(false);
    setError(null);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="nt-aliases-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Aliases of this page"
        onClick={() => {
          setOpen((value) => !value);
          setError(null);
        }}
      >
        <Icon path="mdi-repeat" size={0.7} />
        <span>Aliases · {aliases.length}</span>
      </button>
      {open &&
        !adding &&
        createPortal(
          <div
            ref={popupRef}
            className="nt-aliases-popup"
            role="dialog"
            aria-label="Aliases"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setOpen(false);
              }
            }}
          >
            {aliases.length === 0 ? (
              <p className="nt-aliases-empty">No aliases yet.</p>
            ) : (
              <ul className="nt-aliases-list">
                {aliases.map((alias) => (
                  <li key={alias.id} className="nt-aliases-row">
                    <span className="nt-aliases-row-name">
                      {alias.icon !== null && <Icon path={alias.icon} size={0.7} />}
                      {displayNameFromClient(client, alias.id) ?? alias.id}
                    </span>
                    <button
                      type="button"
                      className="nt-aliases-navigate"
                      title="Open the alias page itself"
                      onClick={() => {
                        setOpen(false);
                        onOpenPageRaw(alias.id);
                      }}
                    >
                      <Icon path="mdi-arrow-right" size={0.7} />
                      Navigate
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="nt-aliases-actions">
              <button
                type="button"
                className="nt-aliases-add"
                onClick={() => {
                  setAdding(true);
                  setError(null);
                }}
              >
                <Icon path="mdi-plus" size={0.7} />
                Add alias
              </button>
            </div>
            {error !== null && (
              <p role="alert" className="nt-picker-error">
                {error}
              </p>
            )}
          </div>,
          document.body,
        )}
      {adding && (
        <NodeSelector
          client={client}
          searchMode="pages"
          excludeNodeId={nodeId}
          canAdd={(node) => node.aliasedNodeId === null}
          anchorEl={buttonRef.current}
          onClose={() => setAdding(false)}
          searchPlaceholder="Search pages…"
          onAdd={(node) => void addAlias(node.id)}
        />
      )}
    </>
  );
}
