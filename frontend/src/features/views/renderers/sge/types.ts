/**
 * SGE v2 — Core type definitions.
 *
 * Public API types and internal engine descriptors.
 */

// ─── Public config ────────────────────────────────────────────────────────────

/** User-facing physics configuration — maps directly from GraphSettings. */
export interface SGEPhysicsConfig {
  preset: 'sparse' | 'balanced' | 'compact' | 'clustered';
  /** Center gravity strength slider (0–100). Maps to componentCenterStrength. */
  centralGravity: number;
  linkCountAttraction: boolean;
  clustering: boolean;
}

/** Raw numeric configuration consumed by the engine. */
export interface SGEConfig {
  seed: number;
  springStrength: number;
  idealDistance: number;
  clusterStrength: number;
  clusterRepelStrength: number;
  clusterSpacing: number;
  localRepelStrength: number;
  localRepelRadius: number;
  componentCenterStrength: number;
  componentSpacing: number;
  damping: number;
  maxVelocity: number;
  friction: number;
  dt: number;
  bhTheta: number;
  linkCountAttraction: boolean;
}

// ─── Edge descriptor ──────────────────────────────────────────────────────────

export interface SGEEdge {
  source: number;
  target: number;
  type?: string;
  weight?: number;
}

// ─── State views ──────────────────────────────────────────────────────────────

/** Typed-array views into the SoA physics state. Valid for indices [0..nodeCount). */
export interface SGEState {
  posX: Float32Array;
  posY: Float32Array;
  velX: Float32Array;
  velY: Float32Array;
  nodeIdArr: Int32Array;
  nodeCount: number;
  energy: number;
  ticks: number;
}

// ─── Internal node descriptor ─────────────────────────────────────────────────

/** Compact node used during engine init — no rendering data. */
export interface SGENode {
  id: number;
  x?: number;
  y?: number;
  connectionCount?: number;
  pinned?: boolean;
}

// ─── Per-link-type physics multipliers ────────────────────────────────────────

export const LINK_REST_MULT: Record<string, number> = {
  parent: 0.6,
  extends: 0.7,
  class: 0.8,
  reference: 1.0,
  'property-reference': 1.1,
  cooccurrence: 1.6,
  temporal: 2.0,
};

export const LINK_STIFF_MULT: Record<string, number> = {
  parent: 1.3,
  extends: 1.2,
  class: 1.0,
  reference: 0.9,
  'property-reference': 0.8,
  cooccurrence: 0.4,
  temporal: 0.3,
};

/** Asymmetry factor applied when a link is shorter than its rest length.
 *  Values > 1 make the link resist compression more strongly. */
export const LINK_COMPRESS_MULT: Record<string, number> = {
  parent: 3.0,
  extends: 2.5,
  class: 2.0,
  reference: 1.0,
  'property-reference': 1.2,
  cooccurrence: 0.6,
  temporal: 0.5,
};
