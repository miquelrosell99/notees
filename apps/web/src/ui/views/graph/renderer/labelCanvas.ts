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
}

/** The v1 label-cap convention: how many labels may render at a zoom level. */
export function labelCapForZoom(zoom: number): number {
  if (zoom < 0.3) return 40;
  if (zoom < 0.6) return 100;
  if (zoom < 1.0) return 200;
  return 500;
}

/** 28-char truncation with an ellipsis (the v1 convention). */
export function truncateLabel(name: string, max = 28): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/** Labels fade in between zoom 0.12 and ~0.47; below that none render. */
export function labelAlphaForZoom(zoom: number): number {
  return Math.min(1, (zoom - 0.12) / 0.35);
}

/**
 * Draw one label pass. Returns the number of regular labels rendered (the
 * hovered/selected emphasis labels don't count against the cap).
 */
export function drawLabels(frame: LabelFrame): number {
  const { ctx, width, height, dpr, zoom } = frame;
  ctx.clearRect(0, 0, width, height);
  if (zoom < 0.12 || frame.order.length === 0) return 0;

  const fontSize = Math.round(Math.min(14, Math.max(9, 11 * zoom)) * dpr);
  const maxLabels = labelCapForZoom(zoom);
  const margin = 100;

  ctx.save();
  ctx.globalAlpha = labelAlphaForZoom(zoom);
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
  const drawAt = (id: string, index: number, color: string): boolean => {
    const name = frame.names.get(id);
    if (name === undefined) return false;
    const sp = frame.worldToScreen(frame.positions[index * 2]!, frame.positions[index * 2 + 1]!);
    if (sp.x < -margin || sp.x > width + margin || sp.y < -40 || sp.y > height + 40) return false;
    ctx.fillStyle = color;
    ctx.fillText(truncateLabel(name), sp.x, sp.y + labelOffsetFor(id));
    return true;
  };

  ctx.fillStyle = frame.colors.regular;
  let rendered = 0;
  for (let i = 0; i < frame.order.length && rendered < maxLabels; i++) {
    const id = frame.order[i]!;
    if (id === frame.selected || id === frame.hovered) continue;
    if (frame.names.get(id) === undefined) continue;
    if (drawAt(id, i, frame.colors.regular)) rendered += 1;
  }

  if (frame.hovered !== null && frame.hovered !== frame.selected) {
    const hIdx = frame.order.indexOf(frame.hovered);
    if (hIdx >= 0) drawAt(frame.hovered, hIdx, frame.colors.emphasis);
  }
  if (frame.selected !== null && frame.selected !== "") {
    const sIdx = frame.order.indexOf(frame.selected);
    if (sIdx >= 0) drawAt(frame.selected, sIdx, frame.colors.emphasis);
  }

  ctx.restore();
  return rendered;
}
