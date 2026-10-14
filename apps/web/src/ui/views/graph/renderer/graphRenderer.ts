/**
 * graphRenderer.ts — the swappable rendering contract between GraphView and a
 * concrete graph renderer (owner 2026-10-14: the PixiJS migration is
 * adapter-first — this interface IS the adapter boundary; see
 * .plans/2026-10-14-0915-pixi-renderer-migration).
 *
 * GraphView must depend only on GraphRenderer, never on a concrete class —
 * a second adapter (Pixi) lands behind the same interface, selected by a
 * device flag, and the WebGL adapter deletes only after parity releases.
 *
 * Coordinate contract (shared by all adapters): world space is the force
 * engine's arbitrary units; the camera's (x, y) is the world point at the
 * canvas centre; zoom is pixels per world unit; clip/screen conversions are
 * the adapter's job.
 */

import type { CameraState, NodeVisual, RendererEdge } from "./webglRenderer.js";

export interface GraphRenderer {
  /** Bind a canvas and build the GPU/scene stack. Throws on init failure. */
  init(canvas: HTMLCanvasElement): void;
  /** Teardown: buffers, contexts, workers owned by the renderer. */
  destroy(): void;
  /** Canvas backing-store resize (device pixels). */
  resize(w: number, h: number): void;

  /** The node set + per-node visuals (radius, optional RGBA). Order here is
   *  the adapter's canonical node order; updatePositions aligns to it. */
  setNodeVisuals(nodeIds: ArrayLike<string>, visuals: Map<string, NodeVisual>): void;
  /** Latest world positions, aligned with the nodeIds given at
   *  setNodeVisuals/updatePositions time. */
  updatePositions(positions: Float32Array, nodeIds: string[]): void;
  /** Single-node position override (drag on the main thread). */
  overridePosition(nodeUuid: string, x: number, y: number): void;

  setEdges(edges: RendererEdge[]): void;
  /** Per-node creation time (seconds since epoch), canonical order;
   *  -Infinity = un-stamped (never time-lapse-hidden). */
  setNodeTimes(secondsByIndex: Float32Array): void;
  /** Time-lapse: hide nodes/edges created after the cutoff. */
  setTimeLapse(enabled: boolean, cutoffSec: number): void;

  /** Hover neighborhood (owner 2026-10-14 ruling): pure color — the hovered
   *  node fills `accent`, its neighbors keep their color, incident edges
   *  paint the accent, everything outside darkens 20%. */
  setHoverNeighborhood(nodeId: string | null, accent?: readonly [number, number, number]): void;
  /** Legacy single-node hover (edge hover evidence + rings). */
  setHoveredNode(id: string): void;
  setHoveredEdge(index: number): void;
  setSelectedNodes(ids: string[]): void;

  setCamera(x: number, y: number, zoom: number): void;
  /** Bitmask of visible link types (LOD family masking). */
  setEdgeMask(mask: number): void;
  setCommunityDim(dim: number): void;

  render(): void;
  /** The camera that fits the current positions with padding. */
  fitToCanvas(paddingPx?: number): CameraState;
  worldToScreen(wx: number, wy: number): { x: number; y: number };
  screenToWorld(px: number, py: number): { x: number; y: number };
  pickNode(wx: number, wy: number, maxDist?: number): string | null;
  /** Edge index under the world point (-1 = none). */
  pickEdge(wx: number, wy: number, maxDist?: number): number;

  readonly nodePositions: Float32Array;
  readonly nodeOrder: string[];
  readonly nodeIndexLookup: ReadonlyMap<string, number>;
  readonly stats: {
    nodeInstCount: number;
    edgeInstCount: number;
    arrowInstCount: number;
    nodeDataCapacity: number;
    edgeDataCapacity: number;
  };
}

/**
 * LOD contract (owner 2026-10-14, in the interface from day one): the adapter
 * owns zoom-driven level-of-detail — point sprites at low zoom, full sprites
 * close, label budget riding the same levels. At 7.5k nodes this path runs
 * continuously; at 50k it is the difference between a usable map and a
 * slideshow. The adapter derives the level from the camera each render; the
 * pure helper keeps the decision testable and identical across adapters.
 */
export type GraphLodLevel = 0 | 1 | 2;

export function lodLevelForZoom(zoom: number): GraphLodLevel {
  if (zoom < 0.25) return 0; // constellation: minimal primitives
  if (zoom < 1.0) return 1; // overview
  return 2; // detail: full sprites + labels
}
