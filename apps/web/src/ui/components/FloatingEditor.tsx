/**
 * FloatingEditor — the pinned floating editor windows (the "full editing"
 * half of the node-hover work, issue #11). Where the hover preview is a
 * transient read-only card, pinning a node promotes it to an independent
 * floating window: the node's own view (the Revision-11 render cascade —
 * ClassView / FocusedBlockView / PageView in embedded mode) inside a small
 * draggable window with a title bar (node title, "open in main", close).
 *
 * Design rulings:
 * - The window edits through the same client write path as every other
 *   surface, so undo (the session journal) and sync come free — no new op,
 *   no new write seam.
 * - The window is deliberately NON-modal: it does not trap focus, dismiss
 *   on outside press, or block the page underneath — editing side by side
 *   with the main view is the point of a floating editor. Focus moves into
 *   the window only deliberately (a click into its tree, or the title bar
 *   on open); closing returns focus to the element that held it when the
 *   window opened (when that element is still mounted).
 * - Hover editing inside the transient preview card is explicitly NOT
 *   offered: the block editor owns the caret and flushes on blur, so a
 *   hover surface that steals focus fights the page editor. Edit = pin.
 * - Windows are siblings at the app shell level, never nested inside one
 *   another (EmbedBoundary thinking): pinning a node that is already
 *   pinned raises its window instead of stacking a duplicate, so mention
 *   chains cannot recurse unbounded.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { rendersAsInlineBlock } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { ClassView } from "../ClassView.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { classIconMap, nodeIcon } from "../iconFor.js";
import { Icon } from "../Icon.js";
import { PageView } from "../PageView.js";
import { Button } from "./ui/Button.js";
import { FocusedBlockView } from "./FocusedBlockView.js";
import "./FloatingEditor.css";

type AnyClient = WorkspaceClient | WorkerClient;

// ── Global opener ──────────────────────────────────────────────────────────
// One host serves the whole app (App-level, under the app shell): any surface
// — the hover preview card, future pin affordances — calls openFloatingEditor
// without threading props through view layers. Mirrors NodeLinkContextMenu.

type Opener = (nodeId: string) => void;
let activeOpener: Opener | null = null;
let activeClose: Opener | null = null;

/** The single host registers itself here (App-level, under the app shell). */
export function registerFloatingEditorOpener(opener: Opener | null, closer: Opener | null): void {
  activeOpener = opener;
  activeClose = closer;
}

/** Pin a node into a floating editor window (no-op before the host mounts). */
export function openFloatingEditor(nodeId: string): void {
  activeOpener?.(nodeId);
}

/** Close one floating editor window (no-op before the host mounts). */
export function closeFloatingEditor(nodeId: string): void {
  activeClose?.(nodeId);
}

interface FloatingWindow {
  nodeId: string;
  x: number;
  y: number;
  z: number;
}

/** Cascade offset per additional window, so a stack stays legible. */
const CASCADE = 28;

export function FloatingEditorHost({
  client,
  openNode,
  children,
}: {
  client: AnyClient;
  /** Main-view navigation ("open in main", links inside the window). */
  openNode: (nodeId: string) => void;
  children: ReactNode;
}) {
  const [windows, setWindows] = useState<FloatingWindow[]>([]);
  /**
   * Mirror of `windows` for event handlers that must read the current set
   * before committing — updater functions stay pure (StrictMode double-runs
   * them, and the codebase convention bans setState nested in setters).
   */
  const windowsRef = useRef<FloatingWindow[]>([]);
  const commitWindows = (next: FloatingWindow[]) => {
    windowsRef.current = next;
    setWindows(next);
  };
  const zCounter = useRef(0);
  /** Focus return ledger: the pinned node's id → the previously focused element. */
  const priorFocus = useRef(new Map<string, Element | null>());
  /** The window that most recently opened (raised) and should take focus. */
  const focusRequest = useRef<string | null>(null);
  const winRefs = useRef(new Map<string, HTMLDivElement>());
  const titlebarRefs = useRef(new Map<string, HTMLElement>());

  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  useEffect(() => {
    const open: Opener = (nodeId) => {
      const existing = windowsRef.current.find((w) => w.nodeId === nodeId);
      zCounter.current += 1;
      const z = zCounter.current;
      focusRequest.current = nodeId;
      if (existing !== undefined) {
        // Already pinned: raise, never stack a duplicate (no recursion).
        commitWindows(
          windowsRef.current.map((w) => (w.nodeId === nodeId ? { ...w, z } : w)),
        );
        return;
      }
      priorFocus.current.set(nodeId, document.activeElement);
      const cascade = windowsRef.current.length % 6;
      commitWindows([
        ...windowsRef.current,
        { nodeId, x: 96 + cascade * CASCADE, y: 72 + cascade * CASCADE, z },
      ]);
    };
    const close: Opener = (nodeId) => {
      commitWindows(windowsRef.current.filter((w) => w.nodeId !== nodeId));
      const prior = priorFocus.current.get(nodeId) ?? null;
      priorFocus.current.delete(nodeId);
      winRefs.current.delete(nodeId);
      titlebarRefs.current.delete(nodeId);
      if (prior instanceof HTMLElement && prior.isConnected) prior.focus();
    };
    registerFloatingEditorOpener(open, close);
    return () => registerFloatingEditorOpener(null, null);
  }, []);

  // Deliberate focus on open: the title bar (not a text field, so pinning
  // never hijacks typing) — the window is keyboard-reachable from there.
  useEffect(() => {
    if (focusRequest.current === null) return;
    const id = focusRequest.current;
    focusRequest.current = null;
    titlebarRefs.current.get(id)?.focus();
  });

  const raise = (nodeId: string) => {
    zCounter.current += 1;
    const z = zCounter.current;
    commitWindows(windowsRef.current.map((w) => (w.nodeId === nodeId ? { ...w, z } : w)));
  };

  const startDrag = (win: FloatingWindow, startX: number, startY: number, target: EventTarget | null) => {
    if (target instanceof Element && target.closest("button") !== null) return;
    const el = winRefs.current.get(win.nodeId);
    const originX = win.x;
    const originY = win.y;
    const width = el?.getBoundingClientRect().width ?? 320;
    const maxX = Math.max(0, window.innerWidth - Math.min(width, 96));
    const maxY = Math.max(0, window.innerHeight - 48);
    // Absolute positioning from the drag origin — idempotent whether the
    // platform delivers pointer- or mouse-compat events for the same gesture.
    const move = (ev: PointerEvent | MouseEvent) => {
      const x = Math.min(Math.max(originX + ev.clientX - startX, 96 - width), maxX);
      const y = Math.min(Math.max(originY + ev.clientY - startY, 0), maxY);
      commitWindows(
        windowsRef.current.map((w) => (w.nodeId === win.nodeId ? { ...w, x, y } : w)),
      );
    };
    const up = () => {
      window.removeEventListener(moveType, move);
      window.removeEventListener(upType, up);
    };
    const pointer = typeof window.PointerEvent === "function";
    const moveType = pointer ? "pointermove" : "mousemove";
    const upType = pointer ? "pointerup" : "mouseup";
    window.addEventListener(moveType, move);
    window.addEventListener(upType, up);
  };

  return (
    <>
      {children}
      {windows.map((win) => {
        const node = client.getNode(win.nodeId);
        const label =
          node === undefined ? win.nodeId : (displayNameFromClient(client, win.nodeId) ?? win.nodeId);
        const icon = node !== undefined ? nodeIcon(node, classIconMap(client.listClasses())) : null;
        return createPortal(
          <div
            key={win.nodeId}
            className="nt-float-win"
            style={
              {
                left: win.x,
                top: win.y,
                "--nt-float-raise": win.z,
              } as CSSProperties
            }
            ref={(el) => {
              if (el === null) winRefs.current.delete(win.nodeId);
              else winRefs.current.set(win.nodeId, el);
            }}
            onPointerDown={() => raise(win.nodeId)}
            data-floating-editor={win.nodeId}
          >
            <header
              className="nt-float-win__titlebar"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                startDrag(win, event.clientX, event.clientY, event.target);
              }}
              onMouseDown={(event) => {
                // Fallback where PointerEvent is unavailable (React only
                // synthesizes pointer handlers when the platform has them).
                if (typeof window.PointerEvent === "function") return;
                if (event.button !== 0) return;
                startDrag(win, event.clientX, event.clientY, event.target);
              }}
            >
              <span
                className="nt-float-win__title"
                title={label}
                tabIndex={-1}
                ref={(el) => {
                  if (el === null) titlebarRefs.current.delete(win.nodeId);
                  else titlebarRefs.current.set(win.nodeId, el);
                }}
              >
                {icon !== null && <Icon path={icon} size={0.8} className="nt-float-win__icon" />}
                <span className="nt-float-win__title-text">{label}</span>
              </span>
              <span className="nt-float-win__actions">
                <Button
                  size="xs"
                  variant="ghost"
                  icon="mdi-arrow-right"
                  aria-label="Open in main view"
                  title="Open in main view"
                  onClick={() => {
                    closeFloatingEditor(win.nodeId);
                    openNode(win.nodeId);
                  }}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  icon="mdi-close"
                  aria-label="Close floating editor"
                  title="Close"
                  onClick={() => closeFloatingEditor(win.nodeId)}
                />
              </span>
            </header>
            <div className="nt-float-win__body">
              {node === undefined ? (
                <div className="nt-page-missing">Page not found.</div>
              ) : (
                <FloatingNodeView client={client} nodeId={win.nodeId} openNode={openNode} />
              )}
            </div>
          </div>,
          document.body,
        );
      })}
    </>
  );
}

/**
 * The render cascade inside one floating window: a class renders the Class
 * View, an inline block the FocusedBlockView, everything else the Page View
 * in embedded mode — the journal-feed composition that suppresses exactly
 * the chrome a floating window carries itself (the page-level find/replace
 * chord, fold chords, cover card, footer). PageView/ClassView build their
 * own OutlinerContext, so the window is a fully independent editor instance.
 */
function FloatingNodeView({
  client,
  nodeId,
  openNode,
}: {
  client: AnyClient;
  nodeId: string;
  openNode: (nodeId: string) => void;
}) {
  const node = client.getNode(nodeId);
  if (node === undefined) return <div className="nt-page-missing">Page not found.</div>;
  if (node.isClass) {
    return <ClassView client={client} classId={nodeId} onOpenClass={openNode} onOpenPage={openNode} />;
  }
  if (rendersAsInlineBlock(node)) {
    return <FocusedBlockView client={client} blockId={nodeId} onOpenNode={openNode} />;
  }
  return (
    <PageView
      client={client}
      pageId={nodeId}
      embedded
      onOpenPage={openNode}
      onDeleted={() => closeFloatingEditor(nodeId)}
    />
  );
}
