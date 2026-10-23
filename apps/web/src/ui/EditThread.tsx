/**
 * EditThread — the edit-mode thread: a separate MEASURED overlay (one SVG
 * polyline) that connects the top-level ancestor bullet to the editing
 * block bullet, taking a turn to the right at every level change, with
 * rounded corners at the turns (owner 2026-10-20, third pass).
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
 * thread down). The overlay mounts on the editable OUTLINE collection's
 * own container (owner ruling 2026-10-23 — the thread is the outline
 * mode's chrome; a host-provided context still wins); it consumes the
 * editing id, resolves the ancestor chain via the client (a parent_id
 * walk that stops at the page root or a standalone
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
 * marker (owner 2026-10-20 — the arm struck through glyphs and read as
 * an overlap). At an INTERMEDIATE glyph the path SURROUNDS its lower-left
 * corner (owner: "keep the downward line in its original position and do
 * a flipped round in the corner, surrounding the icon" — a loop of
 * inverted rounding): the arm stops a radius early, hugs the glyph left
 * edge down, rounds the bottom-left, and rejoins the CENTER column just
 * below the glyph — the downward line keeps its original position, so
 * the staircase columns stay on the bullet centers through dots and
 * icons alike. The path START sits just below a top-level glyph bottom
 * edge for the same reason. The ancestor path
 * dots and icons recolor through CSS (`:has` — app.css "path bullets"),
 * not here. A MutationObserver keeps the path honest when in-path chrome
 * arrives or leaves without a resize/scroll/store event (an icon
 * rendering after an op).
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
 * Resolve the editing block ancestor chain, editing-first. The walk stops
 * at a parentless node, a standalone (non-embedded) parent — the page body
 * never renders inside the tree — a missing read, or the VIEW ROOT. The
 * root itself becomes the chain top ONLY when it renders a measurable
 * bullet: in the page body the root is the page title row (bullet-less),
 * so a nested edit threads up to the top-level block, while in the
 * FOCUSED BLOCK VIEW the root is the focused block row (a real BlockRow
 * with a bullet) — there the thread runs from the focused block down to
 * the editing child (owner 2026-10-20: the focused view showed no thread
 * to the first children level). The host lookup decides which is which.
 */
function chainOf(
  client: WorkspaceClient | WorkerClient,
  host: HTMLElement,
  rootId: string,
  editingId: string,
): string[] {
  const chain: string[] = [];
  let id: string | null = editingId;
  while (id !== null && chain.length < MAX_CHAIN) {
    chain.push(id);
    const node: ClientNode | undefined = client.getNode(id);
    if (node === undefined) break;
    if (node.parentId === null) break;
    const parent = client.getNode(node.parentId);
    if (parent === undefined || parent.isEmbedded === false) break;
    if (node.parentId === rootId) {
      const rootEl = host.querySelector(`[data-block-id="${rootId}"]`);
      const bullet = rootEl?.querySelector(":scope > .nt-block-row .nt-bullet");
      if (rootEl === null || rootEl === undefined || bullet === null) break;
      chain.push(rootId);
      break;
    }
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
   *  before the glyph for icon/marker bullets (owner 2026-10-20: the arm
   *  ended mid-glyph and looked like it struck through the icon). For an
   *  INTERMEDIATE glyph this is also the column the next vertical rides:
   *  the inward corner drops into the gap left of the glyph, so the line
   *  circumvents the icon entirely (owner: "circumvent in-path icons"). */
  ex: number;
  y: number;
  /** The glyph bottom edge (host-relative) for icon/marker bullets, null
   *  for dots — the path STARTS just below a top-level glyph instead of
   *  under its (often transparent) strokes. */
  glyphBottom: number | null;
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
    let glyphBottom: number | null = null;
    const glyph = bullet.querySelector(":scope .nt-bullet-icon, :scope .nt-list-marker");
    if (glyph !== null) {
      const glyphRect = glyph.getBoundingClientRect();
      if (glyphRect.width > 0) {
        ex = glyphRect.left - hostRect.left - GLYPH_GAP;
        glyphBottom = glyphRect.bottom - hostRect.top;
      }
    }
    points.push({ cx, ex, y: rect.top + rect.height / 2 - hostRect.top, glyphBottom });
  }
  return points.length >= 2 ? points : null;
}

/** The thread polyline: down the gap or center column, a rounded right
 *  turn at each level change. An arm ends at each link near edge (`ex`) —
 *  under a dot, before a glyph. At an INTERMEDIATE GLYPH the arm stops a
 *  radius early and an INWARD rounded corner drops the vertical into the
 *  gap column left of the glyph — the line rides the gap to the next
 *  level, never under the glyph (quote icons are hollow strokes; a line
 *  behind them peeks through). Dot links cusp under the opaque dot and
 *  continue in the same column. The path STARTS at the top bullet: at its
 *  center for a dot, just below the glyph bottom edge for an icon. Only
 *  the rounded turns between levels read. */
function threadPath(points: PathPoint[]): string {
  const top = points[0]!;
  const startY = top.glyphBottom === null ? top.y : top.glyphBottom + 1;
  let d = `M ${top.cx} ${startY}`;
  let curX = top.cx;
  let curY = startY;
  for (let i = 1; i < points.length; i += 1) {
    const to = points[i]!;
    if (to.y - RADIUS <= curY) {
      // Degenerate spacing — a plain join (never expected, safe anyway).
      d += ` L ${to.ex} ${to.y}`;
      curX = to.ex;
      curY = to.y;
      continue;
    }
    // Vertical down to this row, then the rounded ┌ turn into the arm.
    d += ` L ${curX} ${to.y - RADIUS} Q ${curX} ${to.y} ${curX + RADIUS} ${to.y}`;
    if (to.glyphBottom === null) {
      // Dot link: the arm ends under the dot; the next vertical continues
      // in the same column (the cusp hides under the opaque dot).
      d += ` L ${to.cx} ${to.y}`;
      curX = to.cx;
      curY = to.y;
      continue;
    }
    if (i === points.length - 1) {
      // Last link (the editing block): the arm simply ends before the
      // glyph — the round linecap finishes it.
      d += ` L ${to.ex} ${to.y}`;
      curX = to.ex;
      curY = to.y;
      continue;
    }
    // Intermediate glyph: end the arm a radius early, then SURROUND the
    // glyph's lower-left corner (owner: "keep the downward line in its
    // original position and do a flipped round in the corner, surrounding
    // the icon") — hug its left edge down, round the bottom-left, and
    // rejoin the CENTER column just below the glyph. The downward line
    // keeps its original position: the staircase columns stay on the
    // bullet centers, straight through dots and icons alike, and the icon
    // reads as sitting on the thread rather than beside it. The under-
    // glyph run passes BELOW the glyph — nothing to peek through.
    const below = to.glyphBottom + GLYPH_GAP;
    d += ` L ${to.ex - RADIUS} ${to.y}`;
    d += ` Q ${to.ex} ${to.y} ${to.ex} ${to.y + RADIUS}`;
    d += ` L ${to.ex} ${below - RADIUS}`;
    d += ` Q ${to.ex} ${below} ${to.ex + RADIUS} ${below}`;
    d += ` L ${to.cx} ${below}`;
    curX = to.cx;
    curY = below;
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
    // A settling pass: bullet geometry can ride a CSS transition (the
    // editing block's icon scales 1.2 over 120ms) — a mutation-driven
    // recompute measures mid-transition and nothing re-fires after the
    // transform settles (transforms mutate no DOM). One re-measure 220ms
    // after the LAST change lets the path settle, then goes quiet.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const update = (settling = false) => {
      raf = 0;
      const points = measureChain(host, chainOf(client, host, rootId, editingId));
      const next = points === null ? null : threadPath(points);
      if (next !== pathRef.current) setPath(next);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = settling ? undefined : setTimeout(() => {
        if (raf === 0) raf = requestAnimationFrame(() => update(true));
      }, 220);
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(() => update(false));
    };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    // A mutation catch-all: in-path chrome arriving or leaving (a class
    // icon rendering after an op, a list marker, collapse) changes the
    // measured geometry without a resize or scroll — the observer keeps
    // the path honest (rAF-throttled; typing churn is a few rect reads).
    const mutations = new MutationObserver(schedule);
    mutations.observe(host, { childList: true, subtree: true });
    const unsubscribe = client.subscribe(schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      unsubscribe();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      if (raf !== 0) cancelAnimationFrame(raf);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
    };
  }, [client, hostRef, rootId, editingId]);

  if (path === null) return null;
  return (
    <svg className="nt-edit-thread-overlay" aria-hidden="true">
      <path d={path} fill="none" stroke="var(--md-sys-color-primary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
