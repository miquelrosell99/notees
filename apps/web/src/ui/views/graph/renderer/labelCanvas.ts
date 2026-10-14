/**
 * labelCanvas.ts — the Canvas 2D label overlay for the graph view.
 *
 * Framework-free port of the archived label pass: zoom-faded alpha, label
 * caps by zoom, 28-char truncation, screen-space culling with a margin, and
 * emphasis colors for the hovered/selected nodes. Colors are INJECTED (the
 * theme helper resolves them from CSS custom properties) so this module
 * stays unit-testable with a stub 2d context.
 */

export interface LabelColors {
  regular: string;
  emphasis: string;
  shadow: string;
}

export interface LabelFrame {
  ctx: CanvasRenderingContext2D;
  /** Canvas backing-store size (already × dpr). */
  width: number;
  height: number;
  dpr: number;
  /** Camera zoom (world → screen scale). */
  zoom: number;
  /** World positions, [x, y] pairs, indexed parallel to `order`. */
  positions: Float32Array;
  /** Node id per position index. */
  order: string[];
  /** Display name per node id. */
  names: Map<string, string>;
  /** World radius per node id (falls back to `baseNodeRadius`). */
  radii: Map<string, number>;
  worldToScreen: (wx: number, wy: number) => { x: number; y: number };
  baseNodeRadius: number;
  hovered: string | null;
  selected: string | null;
  colors: LabelColors;
  /** Node creation times (sec since epoch) — with `timeCutoffSec`, nodes
   *  created after the cutoff are not labelled (the time-lapse pass hides
   *  them on the GL canvas too; the label overlay must follow). */
  createdTimes?: ReadonlyMap<string, number> | undefined;
  /** The time-lapse cutoff (sec since epoch). Absent = label everything. */
  timeCutoffSec?: number | undefined;
}

/** The label-cap convention: how many labels may render at a zoom level.
 * The pass is viewport-first (see drawLabels), so the cap only binds when
 * more nodes are on screen than the cap — at close zoom everything visible
 * labels at once. */
export function labelCapForZoom(zoom: number): number {
  if (zoom < 0.5) return 60;
  if (zoom < 0.8) return 200;
  return 500;
}

/** 28-char truncation with an ellipsis (the original convention). */
export function truncateLabel(name: string, max = 28): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/** Large-graph fade: labels start at zoom 0.3 (owner ruling 2026-10-14:
 * labels appear only when much closer, and all visible ones together) and
 * reach full alpha at 0.7. Small graphs (≤150 nodes) bypass this in
 * drawLabels — they label at any zoom with their own minimum-alpha ramp. */
export function labelAlphaForZoom(zoom: number): number {
  return Math.min(1, (zoom - 0.3) / 0.4);
}

/**
 * The label pass's idle-skip signature (owner 2026-10-13 jank fix): the
 * view's rAF loop redraws labels only when one of these inputs changed
 * since the previous frame — camera, position-frame identity, hover,
 * selection, the name map, the time-lapse cut, or the canvas size. Static
 * frames cost nothing (the canvas2d clear + up to hundreds of shadowed
 * text draws were the main-thread load at ~7k nodes). Identities, not deep
 * compares — the producers replace objects when they change.
 */
export interface LabelDrawSignature {
  camX: number;
  camY: number;
  zoom: number;
  /** The current position frame (object identity marks new positions). */
  frame: unknown;
  hovered: string | null;
  /** The selection array (object identity marks a new selection). */
  selected: unknown;
  /** The display-name map (object identity marks new names). */
  names: unknown;
  tlEnabled: boolean;
  tlCutoff: number;
  width: number;
  height: number;
}

/** True when any label input changed between two frames. */
export function labelSignatureChanged(prev: LabelDrawSignature, next: LabelDrawSignature): boolean {
  return (
    prev.camX !== next.camX ||
    prev.camY !== next.camY ||
    prev.zoom !== next.zoom ||
    prev.frame !== next.frame ||
    prev.hovered !== next.hovered ||
    prev.selected !== next.selected ||
    prev.names !== next.names ||
    prev.tlEnabled !== next.tlEnabled ||
    prev.tlCutoff !== next.tlCutoff ||
    prev.width !== next.width ||
    prev.height !== next.height
  );
}

/**
 * Draw one label pass. Returns the number of regular labels rendered (the
 * hovered/selected emphasis labels don't count against the cap).
 *
 * Owner ruling (2026-10-13, Obsidian reference): while a node hover is
 * active the regular pass STILL runs — zoom threshold and cap respected —
 * but at a quarter alpha (dimmed, never hidden); the hovered node's label
 * ALWAYS renders (even below the zoom threshold) at full alpha, nudged a
 * few pixels below its normal offset; the selected emphasis label is
 * unaffected (full alpha). Without a hover the behavior is unchanged.
 */
export function drawLabels(frame: LabelFrame): number {
  const { ctx, width, height, dpr, zoom } = frame;
  ctx.clearRect(0, 0, width, height);
  const hoveredId = frame.hovered;
  if (frame.order.length === 0) return 0;
  // The zoom threshold only exists to prevent label clutter at scale: small
  // graphs label at any zoom (the Obsidian register — a fitted 54-node graph
  // lands below the threshold and still names its nodes); large graphs keep
  // the fade-in below.
  const smallGraph = frame.order.length <= 150;
  const labelFloor = smallGraph ? 0 : 0.3;
  // The hovered label bypasses the zoom threshold; without a hover the
  // threshold gates the whole pass as before.
  if (zoom < labelFloor && hoveredId === null) return 0;

  const fontSize = Math.round(Math.min(14, Math.max(9, 11 * zoom)) * dpr);
  const maxLabels = labelCapForZoom(zoom);
  const margin = 100;

  ctx.save();
  ctx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.shadowColor = frame.colors.shadow;
  ctx.shadowBlur = 4 * dpr;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  const labelOffsetFor = (id: string): number => {
    const worldRadius = frame.radii.get(id) ?? frame.baseNodeRadius;
    return worldRadius * zoom * dpr + 4 * dpr;
  };
  const timeHidden = (id: string): boolean => {
    if (frame.createdTimes === undefined || frame.timeCutoffSec === undefined) return false;
    const created = frame.createdTimes.get(id);
    return created !== undefined && created > frame.timeCutoffSec;
  };
  const drawAt = (id: string, index: number, color: string, extraDy = 0): boolean => {
    const name = frame.names.get(id);
    if (name === undefined) return false;
    if (timeHidden(id)) return false;
    const sp = frame.worldToScreen(frame.positions[index * 2]!, frame.positions[index * 2 + 1]!);
    if (sp.x < -margin || sp.x > width + margin || sp.y < -40 || sp.y > height + 40) return false;
    ctx.fillStyle = color;
    ctx.fillText(truncateLabel(name), sp.x, sp.y + labelOffsetFor(id) + extraDy);
    return true;
  };

  // Regular pass: dimmed (not hidden) while a hover is active. Owner ruling
  // (2026-10-14): labels appear TOGETHER — the pass is viewport-first with
  // radius priority, so a bound cap spreads across the view instead of
  // labeling the first N nodes in array order; once close enough that every
  // visible node fits the cap, ALL visible labels render at once.
  const baseAlpha = smallGraph
    ? Math.min(1, Math.max(0.3, (zoom - 0.02) / 0.25))
    : labelAlphaForZoom(zoom);
  ctx.globalAlpha = baseAlpha * (hoveredId !== null ? 0.25 : 1);
  let rendered = 0;
  if (zoom >= labelFloor) {
    ctx.fillStyle = frame.colors.regular;
    const visible: number[] = [];
    for (let i = 0; i < frame.order.length; i++) {
      const id = frame.order[i]!;
      if (id === frame.selected || id === hoveredId) continue;
      if (frame.names.get(id) === undefined) continue;
      if (timeHidden(id)) continue;
      const sp = frame.worldToScreen(frame.positions[i * 2]!, frame.positions[i * 2 + 1]!);
      if (sp.x < -margin || sp.x > width + margin || sp.y < -40 || sp.y > height + 40) continue;
      visible.push(i);
    }
    if (visible.length > maxLabels) {
      // Over the cap: the larger nodes (the hubs) claim the labels.
      const radiusOf = (i: number): number => frame.radii.get(frame.order[i]!) ?? frame.baseNodeRadius;
      visible.sort((a, b) => radiusOf(b) - radiusOf(a));
      visible.length = maxLabels;
    }
    for (const i of visible) {
      if (drawAt(frame.order[i]!, i, frame.colors.regular)) rendered += 1;
    }
  }

  // Emphasis passes at FULL alpha — the dimming never touches them.
  ctx.globalAlpha = 1;
  if (zoom >= labelFloor && frame.selected !== null && frame.selected !== "" && frame.selected !== hoveredId) {
    const sIdx = frame.order.indexOf(frame.selected);
    if (sIdx >= 0) drawAt(frame.selected, sIdx, frame.colors.emphasis);
  }
  if (hoveredId !== null) {
    // Always — even below the zoom threshold — with the small downward
    // nudge that reads as "this is the hovered one".
    const hIdx = frame.order.indexOf(hoveredId);
    if (hIdx >= 0) drawAt(hoveredId, hIdx, frame.colors.emphasis, 3 * dpr);
  }

  ctx.restore();
  return rendered;
}
