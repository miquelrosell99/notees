/**
 * Graph Physics & Rendering Constants
 *
 * Tunable parameters for the force-directed graph simulation
 * and canvas rendering quality settings.
 */

// ==================== Physics Constants ====================

// Linked pair attraction (Logseq: distance 70, strength 0.1)
// LINKED_ATTRACTION_DISTANCE is the BASE rest distance for leaf→hub links (degree 1).
// For hub→hub links, rest distance scales up with min(degreeA, degreeB).
export const LINKED_ATTRACTION_DISTANCE = 70;
export const LINK_DISTANCE_DEGREE_SCALE = 15;  // extra distance per log2(minDegree)
export const ATTRACTION_STRENGTH = 0.1;
export const ATTRACTION_STRENGTH_LINK_COUNT = 0.025;
export const LINK_DAMPING = 0.45;

// Unlinked repulsion
export const REPULSION_STRENGTH = 3000;
export const UNLINKED_REPULSION_DISTANCE = 500;
export const MIN_REPULSION_DISTANCE = 1;

// Return-to-target force (constrained modes)
export const RETURN_FORCE = 0.05;

// Center gravity: weak force pulling all nodes toward canvas center.
// Connected nodes resist via springs; orphans settle at the radius where
// gravity = repulsion, forming a natural ring at the periphery.
// This is equivalent to d3.forceX(cx) + d3.forceY(cy) with the given strength.
export const CENTER_GRAVITY_STRENGTH = 0.01;

// Velocity constraints (d3-force: velocityDecay=0.4 → multiply by 0.6)
// Logseq uses velocityDecay=0.6 → multiply by 0.4
export const VELOCITY_DAMPING = 0.6;   // Logseq: 0.4, d3 default: 0.6

// Alpha decay (d3-force style): forces scale by alpha which decays exponentially.
// Logseq: alphaDecay=0.02, d3 default: 0.0228
export const ALPHA_INITIAL = 1;
export const ALPHA_MIN = 0.001;
export const ALPHA_DECAY = 0.006;     // slower decay: ~600 ticks (~10s) to settle
export const ALPHA_TARGET = 0;
export const ALPHA_REHEAT = 0.3;

// Sleep tuning (uses average KE per node, not total)
export const GRAPH_SLEEP_THRESHOLD = 0.00005;
export const GRAPH_SLEEP_FRAMES = 30;

// Drag pull
export const DRAG_PULL_STRENGTH = 0.03;

// Mass accumulation
export const PARENT_MASS_PER_CHILD = 1.0;

// Reference link force multiplier (weaker than parent/class)
export const REFERENCE_LINK_FORCE_MULTIPLIER = 1.0;

// Barnes-Hut
export const BH_THETA = 0.7;
export const BH_THETA_SQ = BH_THETA * BH_THETA;

// Pre-computed squared distances (avoid sqrt in hot loops)
export const UNLINKED_REPULSION_DIST_SQ = UNLINKED_REPULSION_DISTANCE * UNLINKED_REPULSION_DISTANCE;

// Collision resolution (position-based)
export const TANGENTIAL_OVERLAP_RESOLVE = 0.15; // constrained-mode tangential correction

// ==================== Rendering Constants ====================

// LOD (Level of Detail) system for large graph performance
export type LODLevel = 0 | 1;

/** 
 * Compute LOD level based on node count and current zoom. 
 * - LOD 0: Full detail (glare, labels, styled links, arrow dots)
 * - LOD 1: Minimal (pixel dots, hairline links, batched by color)
 */
export const getLODLevel = (nodeCount: number, scale: number): LODLevel => {
  // "density" approximates how many nodes compete for screen space.
  const density = nodeCount / (scale * scale);
  if (density < 4000) return 0;
  return 1;
};

// Node radii
export const NODE_RADIUS_BASE = 6;
export const NODE_RADIUS_MIN = 4;
export const NODE_RADIUS_MAX = 18;
export const NODE_RADIUS_MASS_SCALE = 0.8;
export const NODE_RADIUS_CONN_SCALE = 0.7;
export const NODE_HOVER_RADIUS_EXTRA = 2;

// Glare
export const GLARE_SCALE_NORMAL = 2.5;
export const GLARE_SCALE_BRIGHT = 3.0;
export const GLARE_SCALE_CURRENT = 3.5;
export const GLARE_OPACITY_NORMAL = 0.15;
export const GLARE_OPACITY_BRIGHT = 0.25;
export const GLARE_OPACITY_DIM = 0.02;

// Label fade based on zoom
export const LABEL_FADE_ZOOM_MIN = 0.3;
export const LABEL_FADE_ZOOM_MAX = 0.6;

/** Minimum on-screen node radius in pixels. Prevents nodes from disappearing when zoomed out. */
export const MIN_NODE_SCREEN_RADIUS_PX = 3.0;

// Link type priority
export const LINK_TYPE_PRIORITY: Record<
  'parent' | 'reference' | 'property-reference' | 'class' | 'extends' | 'cooccurrence' | 'temporal' | 'alias',
  number
> = {
  parent: 3,
  extends: 3,
  class: 2,
  'property-reference': 1,
  reference: 0,
  cooccurrence: 0,
  temporal: 0,
  alias: 0,
};

/** Compact numeric IDs for link types (shader & physics use). */
type LinkTypeKey = 'parent' | 'reference' | 'property-reference' | 'class' | 'extends' | 'cooccurrence' | 'temporal' | 'alias';

export const LINK_TYPE_IDS: Record<LinkTypeKey, number> = {
  parent: 0,
  class: 1,
  extends: 2,
  reference: 3,
  'property-reference': 4,
  cooccurrence: 5,
  temporal: 6,
  alias: 7,
};

/** Curvature factor per link type for quadratic Bezier edge bending. */
export const LINK_TYPE_CURVATURE: Record<LinkTypeKey, number> = {
  parent: 0.0,
  extends: 0.05,
  class: 0.05,
  reference: 0.25,
  'property-reference': 0.08,
  cooccurrence: 0.18,
  temporal: 0.25,
  alias: 0.0,
};

/** Rest-length multiplier per link type (relative to idealDistance). */
export const LINK_TYPE_REST_MULT: Record<LinkTypeKey, number> = {
  parent: 0.6,
  extends: 0.7,
  class: 0.8,
  reference: 1.0,
  'property-reference': 1.1,
  cooccurrence: 1.6,
  temporal: 2.0,
  alias: 0.5,
};

/** Stiffness multiplier per link type (relative to base spring strength). */
export const LINK_TYPE_STIFF_MULT: Record<LinkTypeKey, number> = {
  parent: 1.3,
  extends: 1.2,
  class: 1.0,
  reference: 0.9,
  'property-reference': 0.8,
  cooccurrence: 0.4,
  temporal: 0.3,
  alias: 1.5,
};

/** Source/target width multipliers for tapered edges. */
export const EDGE_TAPER_SOURCE_MULT = 1.4;
export const EDGE_TAPER_TARGET_MULT = 0.6;

// Line dash patterns (allocated once)
export const LINE_DASH_NONE: number[] = [];
export const LINE_DASH_DOTTED = [3, 3];
