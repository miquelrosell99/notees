/**
 * Graph Worker Protocol
 * 
 * Type definitions for messages between the main thread and the
 * OffscreenCanvas rendering worker.  The worker handles ONLY rendering;
 * physics simulation stays on the main thread in useNodePhysics.
 * 
 * Data flow:
 *  Main thread  →  (postMessage)  →  Worker
 *    - Init: sends OffscreenCanvas + static node metadata
 *    - Frame: sends compact position arrays every render tick
 *    - Settings/style updates: sent when changed
 *  Worker  →  (postMessage)  →  Main thread
 *    - Ready acknowledgement
 */

import type {
  GraphLink,
  GraphLayoutMode,
  NodeSizeMode,
  LinkDirection,
  GlareState,
} from './viewTypes';

// ==================== Main → Worker ====================

/** Initial setup — transfers the OffscreenCanvas to the worker */
export interface InitMessage {
  type: 'init';
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  dpr: number;
}

/** 
 * Full snapshot of renderable state.  Sent every render tick (at render-skip interval).
 * Uses typed arrays for positions to minimize transfer overhead.
 * 
 * Layout of positionBuffer (Float32Array, 2 floats per node):
 *   [x0, y0, x1, y1, x2, y2, ...]
 * 
 * Layout of stateBuffer (Uint8Array, packed per node):
 *   Byte 0:  flags — bit 0: visible, bit 1: hovered, bit 2: dragged, bit 3: pinned
 *   Byte 1:  glare — 0=normal, 1=bright, 2=dim, 3=path, 4=current
 *   Byte 2:  colorIndex — index into colorPalette array (255 = default)
 *   Byte 3:  reserved
 * 
 * Layout of linkBuffer (Int32Array, 2 ints per link):
 *   [sourceIdx0, targetIdx0, sourceIdx1, targetIdx1, ...]
 * 
 * Layout of linkTypeBuffer (Uint8Array, 1 byte per link):
 *   0=parent, 1=reference, 2=property-reference, 3=class, 4=extends
 */
export interface FrameMessage {
  type: 'frame';
  // Per-node data (indexed by node order)
  positionBuffer: Float32Array;
  stateBuffer: Uint8Array;
  nodeCount: number;
  // Per-link data (indices reference node order, not IDs)
  linkBuffer: Int32Array;
  linkTypeBuffer: Uint8Array;
  linkCount: number;
  // Computed sizing data
  maxConnections: number;
  maxMass: number;
  maxContentSize: number;
  // Transform
  transformX: number;
  transformY: number;
  transformScale: number;
  // Drag state
  dragNodeIndex: number; // -1 if none
  dragLiftProgress: number;
  // View mode
  viewMode: GraphLayoutMode;
  // Node size mode + link direction (needed for radius computation)
  nodeSizeMode: NodeSizeMode;
  linkDirection: LinkDirection;
}

/** Node metadata — sent on init and when nodes change */
export interface NodeMetadataMessage {
  type: 'nodeMetadata';
  /** Node IDs in order (index = position in buffers) */
  nodeIds: number[];
  /** UUIDs for arrow-dot skip detection */
  nodeUuids: string[];
  /** Display names for labels */
  displayNames: string[];
  /** Per-node connection counts (for sizing) */
  connectionCounts: number[];
  inLinkCounts: number[];
  outLinkCounts: number[];
  /** Per-node mass (for sizing) */
  masses: number[];
  /** Per-node content size (for sizing) */
  contentSizes: number[];
  /** Per-node type IDs (for color resolution) */
  nodeTypeIds: number[][];
  /** Per-node color override (null = use class color) */
  nodeColors: (string | null)[];
  /** Per-node isClassNode flag */
  isClassNodes: boolean[];
  /** Tree radii for constrained modes (undefined = not constrained) */
  treeRadii: (number | undefined)[];
}

/** Color palette and CSS vars update */
export interface StyleMessage {
  type: 'style';
  /** Class color palette: [{classId, color, order}] sorted by order */
  classColors: { classId: number; color: string; order: number }[];
  /** Resolved CSS variable colors */
  textColor: string;
  accentColor: string;
  dimColor: string;
  outlineColor: string;
  warningColor: string;
}

/** Canvas resize */
export interface ResizeMessage {
  type: 'resize';
  width: number;
  height: number;
  dpr: number;
}

/** Clean shutdown */
export interface DestroyMessage {
  type: 'destroy';
}

export type MainToWorkerMessage =
  | InitMessage
  | FrameMessage
  | NodeMetadataMessage
  | StyleMessage
  | ResizeMessage
  | DestroyMessage;

// ==================== Worker → Main ====================

export interface ReadyMessage {
  type: 'ready';
}

export type WorkerToMainMessage = ReadyMessage;

// ==================== Helpers ====================

/** Encode GlareState to byte */
export const encodeGlare = (g: GlareState): number => {
  switch (g) {
    case 'normal': return 0;
    case 'bright': return 1;
    case 'dim': return 2;
    case 'path': return 3;
    case 'current': return 4;
    default: return 0;
  }
};

/** Decode byte to GlareState */
export const decodeGlare = (b: number): GlareState => {
  switch (b) {
    case 0: return 'normal';
    case 1: return 'bright';
    case 2: return 'dim';
    case 3: return 'path';
    case 4: return 'current';
    default: return 'normal';
  }
};

/** Encode link type to byte */
export const encodeLinkType = (t: GraphLink['type']): number => {
  switch (t) {
    case 'parent': return 0;
    case 'reference': return 1;
    case 'property-reference': return 2;
    case 'class': return 3;
    case 'extends': return 4;
    default: return 1;
  }
};

/** Decode byte to link type */
export const decodeLinkType = (b: number): GraphLink['type'] => {
  switch (b) {
    case 0: return 'parent';
    case 1: return 'reference';
    case 2: return 'property-reference';
    case 3: return 'class';
    case 4: return 'extends';
    default: return 'reference';
  }
};

/** Pack node state flags into a byte */
export const packNodeFlags = (visible: boolean, hovered: boolean, dragged: boolean, pinned: boolean): number => {
  return (visible ? 1 : 0) | (hovered ? 2 : 0) | (dragged ? 4 : 0) | (pinned ? 8 : 0);
};
