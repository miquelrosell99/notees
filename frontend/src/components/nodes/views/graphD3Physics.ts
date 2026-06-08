/**
 * D3-force physics wrapper for the graph view.
 *
 * Replaces the custom SemanticGraphEngine with d3-force, which is the same
 * library Obsidian uses for its graph view physics.
 *
 * Features:
 * - forceManyBody (Barnes-Hut repulsion)
 * - forceLink (Hookean springs with per-type distance/strength)
 * - forceCenter (weak gravity toward origin)
 * - forceCollide (prevents node overlap)
 * - Custom cluster force (pulls connected components together,
 *   pushes separate components apart)
 * - Alpha cooling (simulation heats on interaction, cools to rest)
 */

import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphNode, GraphLink } from './viewTypes';
import { LINK_TYPE_REST_MULT, LINK_TYPE_STIFF_MULT } from './graphConstants';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface D3PhysicsConfig {
  preset: 'sparse' | 'balanced' | 'compact' | 'clustered';
  centralGravity: boolean;
  linkCountAttraction: boolean;
  strongClustering?: boolean;
}

interface D3Node extends SimulationNodeDatum {
  id: number;
  /** Original GraphNode reference — kept in sync by the caller. */
  graphNode: GraphNode;
  /** Connected-component id used by the cluster force. */
  compId?: number;
}

interface D3Link extends SimulationLinkDatum<D3Node> {
  type: GraphLink['type'];
  weight?: number;
}

// ─── Presets ──────────────────────────────────────────────────────────────────

const PRESETS: Record<D3PhysicsConfig['preset'], {
  charge: number;
  linkDistance: number;
  linkStrength: number;
  centerStrength: number;
  collideRadius: number;
  clusterStrength: number;
  clusterRepel: number;
}> = {
  sparse: {
    charge: -400,
    linkDistance: 140,
    linkStrength: 0.4,
    centerStrength: 0.015,
    collideRadius: 12,
    clusterStrength: 0.03,
    clusterRepel: 80,
  },
  balanced: {
    charge: -300,
    linkDistance: 100,
    linkStrength: 0.6,
    centerStrength: 0.025,
    collideRadius: 10,
    clusterStrength: 0.04,
    clusterRepel: 120,
  },
  compact: {
    charge: -200,
    linkDistance: 60,
    linkStrength: 0.8,
    centerStrength: 0.04,
    collideRadius: 8,
    clusterStrength: 0.06,
    clusterRepel: 200,
  },
  clustered: {
    charge: -450,
    linkDistance: 110,
    linkStrength: 0.5,
    centerStrength: 0.02,
    collideRadius: 11,
    clusterStrength: 0.08,
    clusterRepel: 180,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Simple union-find for connected components. */
function findConnectedComponents(nodes: D3Node[], links: D3Link[]): Map<number, number> {
  const parent = new Map<number, number>();
  for (const n of nodes) parent.set(n.id, n.id);

  function find(x: number): number {
    let p = parent.get(x)!;
    while (p !== parent.get(p)!) {
      parent.set(p, parent.get(parent.get(p)!)!);
      p = parent.get(p)!;
    }
    return p;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const l of links) {
    const s = typeof l.source === 'number' ? l.source : (l.source as D3Node).id;
    const t = typeof l.target === 'number' ? l.target : (l.target as D3Node).id;
    union(s, t);
  }

  const compMap = new Map<number, number>();
  let compIdx = 0;
  const rootToComp = new Map<number, number>();
  for (const n of nodes) {
    const root = find(n.id);
    if (!rootToComp.has(root)) rootToComp.set(root, compIdx++);
    compMap.set(n.id, rootToComp.get(root)!);
  }
  return compMap;
}

/** Custom force that pulls nodes toward their component centroid and pushes components apart. */
function forceCluster(strength: number, repel: number) {
  let nodes: D3Node[] = [];
  let links: D3Link[] = [];
  let compMap = new Map<number, number>();

  function force(alpha: number) {
    // Recompute components if topology changed (simple heuristic)
    if (nodes.length > 0) {
      compMap = findConnectedComponents(nodes, links);
      for (const n of nodes) n.compId = compMap.get(n.id) ?? 0;
    }

    // Gather component centroids
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cc = new Map<number, number>();
    for (const n of nodes) {
      const c = n.compId ?? 0;
      cx.set(c, (cx.get(c) ?? 0) + (n.x ?? 0));
      cy.set(c, (cy.get(c) ?? 0) + (n.y ?? 0));
      cc.set(c, (cc.get(c) ?? 0) + 1);
    }
    for (const [c, cnt] of cc) {
      cx.set(c, (cx.get(c) ?? 0) / cnt);
      cy.set(c, (cy.get(c) ?? 0) / cnt);
    }

    // Pull nodes toward their component centroid
    for (const n of nodes) {
      const c = n.compId ?? 0;
      const dx = (cx.get(c) ?? 0) - (n.x ?? 0);
      const dy = (cy.get(c) ?? 0) - (n.y ?? 0);
      n.vx = (n.vx ?? 0) + dx * strength * alpha;
      n.vy = (n.vy ?? 0) + dy * strength * alpha;
    }

    // Push component centroids apart (simplified: pairwise repulsion)
    const ids = [...cc.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const dx = (cx.get(a) ?? 0) - (cx.get(b) ?? 0);
        const dy = (cy.get(a) ?? 0) - (cy.get(b) ?? 0);
        const dist2 = dx * dx + dy * dy || 1;
        const dist = Math.sqrt(dist2);
        const f = (repel * alpha) / dist;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;

        // Distribute force evenly to member nodes
        const ca = cc.get(a)!, cb = cc.get(b)!;
        for (const n of nodes) {
          if ((n.compId ?? 0) === a) {
            n.vx = (n.vx ?? 0) + fx / ca;
            n.vy = (n.vy ?? 0) + fy / ca;
          } else if ((n.compId ?? 0) === b) {
            n.vx = (n.vx ?? 0) - fx / cb;
            n.vy = (n.vy ?? 0) - fy / cb;
          }
        }
      }
    }
  }

  (force as unknown as { initialize: (n: D3Node[], l: D3Link[]) => void }).initialize = (
    n: D3Node[],
    l: D3Link[],
  ) => {
    nodes = n;
    links = l;
  };

  return force as unknown as (
    alpha: number,
  ) => void & { initialize: (n: D3Node[], l: D3Link[]) => void };
}

// ─── Engine class ─────────────────────────────────────────────────────────────

export class D3GraphEngine {
  private simulation: Simulation<D3Node, D3Link>;
  private d3Nodes: D3Node[] = [];
  private d3Links: D3Link[] = [];
  private config: D3PhysicsConfig;
  private nodeMap = new Map<number, D3Node>();
  private _energy = 0;

  // Forces (kept as refs so we can update them live)
  private fManyBody = forceManyBody<D3Node>();
  private fLink = forceLink<D3Node, D3Link>();
  private fCenter = forceCenter<D3Node>(0, 0);
  private fCollide = forceCollide<D3Node>(10);
  private fCluster = forceCluster(0, 0);

  constructor(
    nodes: GraphNode[],
    links: GraphLink[],
    config: D3PhysicsConfig = {
      preset: 'balanced',
      centralGravity: true,
      linkCountAttraction: false,
    },
  ) {
    this.config = config;
    this.simulation = forceSimulation<D3Node, D3Link>()
      .alphaDecay(0.02) // ~300 ticks to cool (Obsidian-like)
      .velocityDecay(0.4); // d3 default = 0.4 (Obsidian feel)

    this.rebuild(nodes, links);
  }

  /** Full topology rebuild. */
  rebuild(nodes: GraphNode[], links: GraphLink[]): void {
    // Preserve positions of existing nodes
    const posMap = new Map<number, { x: number; y: number }>();
    for (const n of this.d3Nodes) {
      if (n.x != null && n.y != null) posMap.set(n.id, { x: n.x, y: n.y });
    }

    this.d3Nodes = nodes.map(n => {
      const prev = posMap.get(n.id);
      return {
        id: n.id,
        graphNode: n,
        x: prev?.x ?? n.x,
        y: prev?.y ?? n.y,
        vx: 0,
        vy: 0,
      };
    });

    this.nodeMap.clear();
    for (const n of this.d3Nodes) this.nodeMap.set(n.id, n);

    this.d3Links = links.map(l => ({
      source: l.source,
      target: l.target,
      type: l.type,
      weight: l.weight,
    }));

    this.simulation.nodes(this.d3Nodes);
    this.fLink.links(this.d3Links);
    this.applyConfig(this.config);

    // Restart hot so new layout resolves immediately
    this.simulation.alpha(1).restart();
  }

  /** Live-update physics parameters. */
  setConfig(config: D3PhysicsConfig): void {
    this.config = config;
    this.applyConfig(config);
    this.simulation.alpha(0.3).restart();
  }

  private applyConfig(config: D3PhysicsConfig): void {
    const preset = PRESETS[config.preset];

    // Charge (repulsion)
    this.fManyBody.strength(preset.charge);

    // Link force
    this.fLink
      .id((d: D3Node) => d.id)
      .distance((d: D3Link) => {
        const mult = LINK_TYPE_REST_MULT[d.type] ?? 1.0;
        return preset.linkDistance * mult;
      })
      .strength((d: D3Link) => {
        const source = typeof d.source === 'number'
          ? this.nodeMap.get(d.source)
          : (d.source as D3Node);
        const target = typeof d.target === 'number'
          ? this.nodeMap.get(d.target)
          : (d.target as D3Node);
        if (!source || !target) return 0;

        const sDeg = source.graphNode.connectionCount || 1;
        const tDeg = target.graphNode.connectionCount || 1;
        const maxDeg = Math.max(sDeg, tDeg, 1);
        const stiffScale = config.linkCountAttraction
          ? 1 / Math.sqrt(maxDeg)
          : 1 / maxDeg;
        const mult = LINK_TYPE_STIFF_MULT[d.type] ?? 1.0;
        return preset.linkStrength * stiffScale * mult;
      });

    // Center gravity
    this.fCenter.strength(config.centralGravity ? preset.centerStrength : 0);

    // Collision
    this.fCollide.radius((_d: D3Node) => preset.collideRadius);

    // Cluster force
    const clusterStr = config.strongClustering
      ? preset.clusterStrength * 2.2
      : preset.clusterStrength;
    const clusterRepel = config.strongClustering
      ? preset.clusterRepel * 1.8
      : preset.clusterRepel;
    this.fCluster = forceCluster(clusterStr, clusterRepel);
    (this.fCluster as unknown as { initialize: (n: D3Node[], l: D3Link[]) => void }).initialize(this.d3Nodes, this.d3Links);

    // Re-assemble force list
    this.simulation
      .force('charge', this.fManyBody)
      .force('link', this.fLink)
      .force('center', this.fCenter)
      .force('collide', this.fCollide)
      .force('cluster', this.fCluster);
  }

  /** Step the simulation by one tick. */
  tick(): void {
    this.simulation.tick(1);

    // Sync positions back to GraphNode objects
    for (const n of this.d3Nodes) {
      n.graphNode.x = n.x ?? 0;
      n.graphNode.y = n.y ?? 0;
      n.graphNode.vx = n.vx ?? 0;
      n.graphNode.vy = n.vy ?? 0;
    }

    // Rough energy estimate for stats overlay
    let e = 0;
    for (const n of this.d3Nodes) {
      e += ((n.vx ?? 0) ** 2 + (n.vy ?? 0) ** 2);
    }
    this._energy = this.d3Nodes.length > 0 ? e / this.d3Nodes.length : 0;
  }

  /** Pack current positions into a flat Float32Array [x0,y0, x1,y1, ...]. */
  packPositions(out: Float32Array, nodeIds: Int32Array): void {
    for (let i = 0; i < nodeIds.length; i++) {
      const n = this.nodeMap.get(nodeIds[i]);
      if (n) {
        out[i * 2] = n.x ?? 0;
        out[i * 2 + 1] = n.y ?? 0;
      }
    }
  }

  /** Pin a node (drag start). */
  startDrag(nodeId: number): void {
    const n = this.nodeMap.get(nodeId);
    if (!n) return;
    n.fx = n.x;
    n.fy = n.y;
    this.simulation.alphaTarget(0.3).restart();
  }

  /** Move a pinned node (drag move). */
  moveDrag(nodeId: number, x: number, y: number): void {
    const n = this.nodeMap.get(nodeId);
    if (!n) return;
    n.fx = x;
    n.fy = y;
    n.x = x;
    n.y = y;
  }

  /** Unpin a node (drag end). */
  endDrag(nodeId: number): void {
    const n = this.nodeMap.get(nodeId);
    if (!n) return;
    n.fx = null;
    n.fy = null;
    this.simulation.alphaTarget(0);
  }

  /** Pause the simulation timer. */
  pause(): void {
    this.simulation.stop();
  }

  /** Resume / reheat. */
  resume(): void {
    this.simulation.restart();
  }

  get energy(): number {
    return this._energy;
  }

  get tickCount(): number {
    // d3 doesn't expose a public tick counter; we don't need it for rendering.
    return 0;
  }

  get nodeCount(): number {
    return this.d3Nodes.length;
  }

  dispose(): void {
    this.simulation.stop();
  }
}
