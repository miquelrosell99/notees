/**
 * NodeHoverPreview — the hover preview card for inline node links (issue
 * #11). Dwelling on a mention (~400ms) raises a bounded, read-only card
 * anchored at the mention: the target's icon + title + a one-line content
 * excerpt + backlink count (the EmbedCardView identity set). The card is a
 * trampoline, not an editor — the block editor owns the caret and flushes
 * on blur, so a hover surface that steals focus would fight the page
 * editor. "Full editing" is the card's pin affordance, which promotes the
 * node to a FloatingEditor window (deliberate, focus-moving, closable).
 *
 * Plumbing mirrors NodeLinkContextMenu: InlineTokens calls the module-level
 * notifyNodeHover(...) on mouseenter/leave of every mention (no caller
 * wiring, works in every surface that renders mentions), and the single
 * NodeHoverPreviewHost mounted at the app shell owns the dwell/grace state
 * machine:
 *
 * - enter (no button held — suppressed while dragging): arm the dwell
 *   timer; entering a different mention re-targets the preview when its
 *   dwell elapses.
 * - leave: disarm the dwell; when the card is open, start a short grace
 *   timer so the pointer can travel into the card itself; re-entering the
 *   mention or the card cancels the hide.
 * - any pointer-down cancels a pending dwell (a press is an intent to
 *   interact, not to hover) and hides an open card whose anchor is being
 *   pressed (the press navigates through the mention).
 * - dismissal composes usePopupDismissal (§34.67): Escape from outside +
 *   pointer-down outside close; the mention anchor counts as part of the
 *   surface for the outside-pointer check.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { rendersAsInlineBlock } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";
import { proseFromAst } from "@/editor/prose.js";

import { displayNameFromClient } from "../dateDisplay.js";
import { openFloatingEditor } from "./FloatingEditor.js";
import { nodeIcon } from "../iconFor.js";
import { Icon } from "../Icon.js";
import { renderStateLabel } from "../renderStateLabel.js";
import { Button } from "./ui/Button.js";
import { usePopupDismissal } from "./ui/usePopupDismissal.js";
import "./NodeHoverPreview.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Dwell before the card raises; grace while the pointer travels to it. */
export const HOVER_DWELL_MS = 400;
export const HOVER_GRACE_MS = 250;

// ── Global listener ─────────────────────────────────────────────────────────
// One host serves the whole app; InlineTokens notifies enter/leave for every
// mention without threading props through the view layers.

type HoverPhase = "enter" | "leave";
type HoverListener = (
  targetNodeId: string,
  phase: HoverPhase,
  source: HTMLElement,
  buttons: number,
) => void;

let activeListener: HoverListener | null = null;

/** The single host registers itself here (App-level, under the app shell). */
export function registerNodeHoverListener(listener: HoverListener | null): void {
  activeListener = listener;
}

/**
 * Mention hover notification from any surface (no-op before the host
 * mounts — e.g. export projections rendered without the app shell).
 */
export function notifyNodeHover(
  targetNodeId: string,
  phase: HoverPhase,
  source: HTMLElement,
  buttons = 0,
): void {
  activeListener?.(targetNodeId, phase, source, buttons);
}

interface PreviewState {
  nodeId: string;
  anchorEl: HTMLElement;
  top: number;
  left: number;
}

/** Anchor position → fixed card position (right-clamped, flips above when
 *  the viewport below is too tight to hold the card's estimated height). */
function cardPosition(anchor: HTMLElement): { top: number; left: number } {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(340, Math.max(0, window.innerWidth - 16));
  const left = Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - width - 8));
  const below = rect.bottom + 6;
  const top = below + 240 > window.innerHeight && rect.top > 260 ? rect.top - 6 : below;
  return { top: Math.max(8, top), left };
}

export function NodeHoverPreviewHost({
  client,
  openNode,
  children,
}: {
  client: AnyClient;
  /** Main-view navigation (the card's title click). */
  openNode: (nodeId: string) => void;
  children: ReactNode;
}) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The dwell's candidate anchor — leave only disarms its own dwell. */
  const dwellSource = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = preview?.anchorEl ?? null;

  const clearDwell = () => {
    if (dwellTimer.current !== null) clearTimeout(dwellTimer.current);
    dwellTimer.current = null;
    dwellSource.current = null;
  };
  const clearGrace = () => {
    if (graceTimer.current !== null) clearTimeout(graceTimer.current);
    graceTimer.current = null;
  };

  const hide = () => {
    clearDwell();
    clearGrace();
    setPreview(null);
  };

  useEffect(() => {
    const onHover: HoverListener = (nodeId, phase, source, buttons) => {
      if (phase === "enter") {
        clearGrace();
        if (buttons !== 0) return; // a held button means a drag, not a hover
        if (preview?.anchorEl === source) return; // already open on this mention
        clearDwell();
        dwellSource.current = source;
        dwellTimer.current = setTimeout(() => {
          dwellTimer.current = null;
          dwellSource.current = null;
          // The mention may have navigated away or unmounted meanwhile.
          if (!source.isConnected) return;
          setPreview({ nodeId, anchorEl: source, ...cardPosition(source) });
        }, HOVER_DWELL_MS);
        return;
      }
      // leave
      if (dwellSource.current === source) clearDwell();
      if (preview?.anchorEl === source) {
        clearGrace();
        graceTimer.current = setTimeout(() => {
          graceTimer.current = null;
          setPreview(null);
        }, HOVER_GRACE_MS);
      }
    };
    registerNodeHoverListener(onHover);
    return () => registerNodeHoverListener(null);
    // The listener reads the latest preview via the effect re-run on change.
  }, [preview]);

  // A press is never a hover: cancel the pending dwell, and hide an open
  // card whose own mention is being pressed (the press navigates through).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (dwellTimer.current !== null) clearDwell();
      if (preview === null) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      const inCard = cardRef.current !== null && cardRef.current.contains(target);
      const inAnchor = preview.anchorEl.isConnected && preview.anchorEl.contains(target);
      // Pressing the mention itself navigates through it — the card goes away.
      if (inAnchor && !inCard) hide();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  });

  usePopupDismissal({
    popupRef: cardRef,
    anchorRefs: [anchorRef],
    isOpen: preview !== null,
    onClose: hide,
  });

  return (
    <>
      {children}
      {preview !== null &&
        createPortal(
          <div
            ref={cardRef}
            className="nt-hover-preview"
            role="dialog"
            aria-label={`${renderStateLabelOf(client, preview.nodeId)} preview`}
            style={{ top: preview.top, left: preview.left }}
            onMouseEnter={clearGrace}
            onKeyDown={(event) => {
              // §34.67 contract: an Escape that originates inside the popup
              // belongs to the popup — the card has no sub-states, so it
              // closes (and never leaks the Escape outward).
              if (event.key === "Escape") {
                event.stopPropagation();
                hide();
              }
            }}
            onMouseLeave={() => {
              clearGrace();
              graceTimer.current = setTimeout(() => {
                graceTimer.current = null;
                setPreview(null);
              }, HOVER_GRACE_MS);
            }}
          >
            <NodeHoverPreviewCard
              client={client}
              nodeId={preview.nodeId}
              onOpen={() => {
                const id = preview.nodeId;
                hide();
                openNode(id);
              }}
              onPin={() => {
                const id = preview.nodeId;
                hide();
                openFloatingEditor(id);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

/** The card's aria label names the render state like the link menu does. */
function renderStateLabelOf(client: AnyClient, nodeId: string): string {
  const node = client.getNode(nodeId);
  return node === undefined ? "Node" : renderStateLabel(node);
}

function NodeHoverPreviewCard({
  client,
  nodeId,
  onOpen,
  onPin,
}: {
  client: AnyClient;
  nodeId: string;
  onOpen: () => void;
  onPin: () => void;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const node = client.getNode(nodeId);
  if (node === undefined) {
    // Broken-mention fallback philosophy: the raw id, honestly.
    return (
      <div className="nt-hover-preview__broken" title={nodeId}>
        broken reference <code>{nodeId}</code>
      </div>
    );
  }

  const icon = nodeIcon(node, client.effectiveClassIcons());
  const label = displayNameFromClient(client, nodeId) ?? nodeId;
  const excerpt = excerptOf(node.contentAst);
  const backlinkCount = client.getBacklinkCount(nodeId);
  const isBlock = rendersAsInlineBlock(node);

  return (
    <>
      <button type="button" className="nt-hover-preview__main" title={label} onClick={onOpen}>
        <span className="nt-hover-preview__head">
          {icon !== null && <Icon path={icon} size={0.9} className="nt-hover-preview__icon" />}
          <span className="nt-hover-preview__title">{label}</span>
          {isBlock && <span className="nt-hover-preview__kind">block</span>}
        </span>
        {excerpt !== "" && <span className="nt-hover-preview__excerpt">{excerpt}</span>}
      </button>
      <div className="nt-hover-preview__meta">
        <span className="nt-hover-preview__backlinks">
          {backlinkCount === 1 ? "1 backlink" : `${backlinkCount} backlinks`}
        </span>
        <Button
          size="xs"
          variant="outline"
          icon="mdi-pin-outline"
          aria-label="Pin — edit in a floating window"
          title="Pin — edit in a floating window"
          onClick={onPin}
        >
          Pin
        </Button>
      </div>
    </>
  );
}

/** One-line plaintext teaser of a content stream (the wide-card excerpt set). */
function excerptOf(contentAst: readonly unknown[]): string {
  const text = proseFromAst(contentAst).replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
