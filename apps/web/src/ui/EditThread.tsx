/**
 * EditThread — the edit-mode thread: a separate MEASURED overlay (one SVG
 * polyline) that connects the top-level ancestor bullet to the editing
 * block bullet, taking a turn to the right at every level change, with
 * rounded corners at the turns.
 *
 * Why an overlay: the two earlier takes styled the tree indent rail
 * (`:has()` accents + pseudo arms) — that highlighted the whole subtree
 * column at each level and could only ride full-height rails, not the
 * path. The owner reference look is one continuous line anchored AT the
 * bullets — a different shape from the tree chrome, so it is drawn as its
 * own layer, measured from the rendered bullets.
 *
 * Mechanics: BlockRow reports its editing state through EditThreadContext
 * (reportEditing on enter, clearEditing on exit/unmount — the guard only
 * clears the id it set, so a hand-off between blocks cannot tear the new
 * thread down). The overlay mounts inside the page select surface (the
 * host); it consumes the editing id, resolves the ancestor chain via the
 * client (a parent_id walk that stops at the page root or a standalone
 * node), and measures each path bullet box. One path is built top-down:
 * start at the top block bullet center, run down its column, a quadratic
 * rounded turn (RADIUS) into each deeper bullet near edge, ending at the
 * editing block dot. The overlay carries z-index 1: ABOVE the tree chrome
 * (the resting rail is a positioned button — without the explicit layer
 * it would strike over the thread by DOM order) and BELOW the bullets
 * and the hover chevron (both carry z-index: 2), so the dots sit on the
 * line, and it is pointer-events: none — it never eats clicks (the rail
 * fold gesture underneath keeps working). Each arm ends at the path
 * bullet NEAR EDGE: under a dot, a few px BEFORE a class icon or list
 * marker; at an INTERMEDIATE glyph the path jogs back to the center
 * column under the opaque icon (hidden behind it — icons paint above the
 * overlay) and the next vertical descends from there. The ancestor path
 * dots and icons recolor through CSS (`:has` — app.css "path bullets"),
 * not here.
 * Recomputed on edit changes, store notifications, host resizes, and any
 * scroll (the bullets move with the scroller); a missing bullet (prose
 * hides them, cards mode, a not-rendered ancestor, a top-level edit)
 * renders no thread.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

interface EditThreadContextValue {
  /** The block currently in edit mode, or null. */
  editingId: string | null;
  /** BlockRow: this block entered edit mode. */
  reportEditing: (id: string) => void;
  /** BlockRow: this block left edit mode (clears only if it still owns the id). */
  clearEditing: (id: string) => void;
}

export const EditThreadContext = createContext<EditThreadContextValue | null>(null);

/** The page body hosts the overlay provider around its block tree. */
export function EditThreadProvider({ children }: { children: ReactNode }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const value = useMemo<EditThreadContextValue>(
    () => ({
      editingId,
      reportEditing: (id) => setEditingId(id),
      clearEditing: (id) => setEditingId((current) => (current === id ? null : current)),
    }),
    [editingId],
  );
  return <EditThreadContext.Provider value={value}>{children}</EditThreadContext.Provider>;
}

/** BlockRow consumes this (null where no provider renders — read-only
 *  projections, foreign surfaces — and reports nothing). */
export function useEditThread(): EditThreadContextValue | null {
  return useContext(EditThreadContext);
}

/** Rounded-corner radius at each level change (px — a hairline-adjacent
 *  constant, the stroke is the 2px accent hairline). */
const RADIUS = 5;
/** The walk depth guard — a pathological parent chain can never hang the
 *  overlay. */
const MAX_CHAIN = 1000;

/**
 * Resolve the editing block ancestor chain, editing-first: the walk
 * stops at the page root (a top-level block), a parentless node, a
 * standalone (non-embedded) parent — the page body never renders inside
 * the tree — or a missing read.
 */
function chainOf(client: WorkspaceClient | WorkerClient, rootId: string, editingId: string): string[] {
  const chain: string[] = [];
  let id: string | null = editingId;
  while (id !== null && chain.length < MAX_CHAIN) {
    chain.push(id);
    const node: ClientNode | undefined = client.getNode(id);
    if (node === undefined) break;
    if (node.parentId === null || node.parentId === rootId) break;
    const parent = client.getNode(node.parentId);
    if (parent === undefined || parent.isEmbedded === false) break;
    id = node.parentId;
  }
  return chain;
}

/** The gap left before a glyph (class icon / list marker) when a thread
 *  arm ends at one (px — a breathing gap, not a measured dimension). */
const GLYPH_GAP = 3;

interface PathPoint {
  /** The bullet CENTER column — verticals ride it. */
  cx: number;
  /** Where a horizontal ARM ends — the center for a dot bullet, a few px
   *  before the glyph for icon/marker bullets (the arm
   *  ended mid-glyph and looked like it struck through the icon). */
  ex: number;
  y: number;
}

/** Measure the path bullets (top-level ancestor first) in host-relative
 *  coordinates. Returns null when any link is not rendered with a visible
 *  bullet (prose, cards, a collapsed/out-of-tree ancestor) — no thread. */
function measureChain(
  host: HTMLElement,
  chainEditingFirst: string[],
): PathPoint[] | null {
  const hostRect = host.getBoundingClientRect();
  const points: PathPoint[] = [];
  for (let i = chainEditingFirst.length - 1; i >= 0; i -= 1) {
    const block = host.querySelector(`[data-block-id="${chainEditingFirst[i]}"]`);
    const bullet = block?.querySelector(":scope > .nt-block-row .nt-bullet");
    if (bullet === null || bullet === undefined) return null;
    const rect = bullet.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null; // hidden (prose)
    const cx = rect.left + rect.width / 2 - hostRect.left;
    let ex = cx;
    const glyph = bullet.querySelector(":scope .nt-bullet-icon, :scope .nt-list-marker");
    if (glyph !== null) {
      const glyphRect = glyph.getBoundingClientRect();
      if (glyphRect.width > 0) ex = glyphRect.left - hostRect.left - GLYPH_GAP;
    }
    points.push({ cx, ex, y: rect.top + rect.height / 2 - hostRect.top });
  }
  return points.length >= 2 ? points : null;
}

/** The thread polyline: down each bullet column, a rounded right turn at
 *  each level change. An arm ends at each link near edge (its `ex`) —
 *  under a dot, before a glyph. At an INTERMEDIATE link the path then jogs
 *  back to the center column (`cx`) under the glyph — hidden behind the
 *  opaque icon, which paints above the overlay — and the next vertical
 *  descends from there. Only the rounded ┌ turns between levels read. */
function threadPath(points: PathPoint[]): string {
  let d = `M ${points[0]!.cx} ${points[0]!.y}`;
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1]!;
    const to = points[i]!;
    if (to.y - RADIUS <= from.y) {
      // Degenerate spacing — a plain join (never expected, safe anyway).
      d += ` L ${to.ex} ${to.y}`;
      continue;
    }
    d += ` L ${from.cx} ${to.y - RADIUS} Q ${from.cx} ${to.y} ${from.cx + RADIUS} ${to.y} L ${to.ex} ${to.y}`;
    if (i < points.length - 1) {
      // Intermediate link: duck back under the glyph for the next vertical.
      d += ` L ${to.cx} ${to.y}`;
    }
  }
  return d;
}

/**
 * The overlay itself — mounted by the page select surface (the host).
 * Recomputes the path on edit changes, store notifications, host resizes,
 * and any scroll, rAF-throttled.
 */
export function EditThreadOverlay({
  client,
  hostRef,
  rootId,
}: {
  client: WorkspaceClient | WorkerClient;
  hostRef: RefObject<HTMLElement | null>;
  rootId: string;
}) {
  const thread = useContext(EditThreadContext);
  const editingId = thread?.editingId ?? null;
  const [path, setPath] = useState<string | null>(null);
  const pathRef = useRef<string | null>(null);
  pathRef.current = path;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || editingId === null || typeof ResizeObserver === "undefined") {
      setPath(null);
      return;
    }
    // Prose hides the bullets (the cards mode renders none) — no line to draw.
    if (host.querySelector(".nt-prose") !== null) {
      setPath(null);
      return;
    }
    let raf = 0;
    const update = () => {
      raf = 0;
      const points = measureChain(host, chainOf(client, rootId, editingId));
      const next = points === null ? null : threadPath(points);
      if (next !== pathRef.current) setPath(next);
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(update);
    };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    const unsubscribe = client.subscribe(schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      unsubscribe();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [client, hostRef, rootId, editingId]);

  if (path === null) return null;
  return (
    <svg className="nt-edit-thread-overlay" aria-hidden="true">
      <path d={path} fill="none" stroke="var(--md-sys-color-primary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
