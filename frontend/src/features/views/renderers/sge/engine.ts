/**
 * SGE v2 — Semantic Graph Engine.
 *
 * Orchestrates force-directed layout with:
 * • Structure-of-Arrays typed arrays
 * • Composable force plugins
 * • Alpha cooling for natural settling
 * • Louvain community detection
 * • Barnes–Hut cluster repulsion
 */

import type { SGEConfig, SGEEdge, SGEState, SGENode } from './types';
import { LINK_REST_MULT, LINK_STIFF_MULT, LINK_COMPRESS_MULT } from './types';
import type { ForcePlugin } from './forces/interface';
import { SpringForce } from './forces/springs';
import { LocalRepelForce } from './forces/localRepel';
import { ClusterCohesionForce } from './forces/clusterCohesion';
import { ClusterRepulsionForce } from './forces/clusterRepulsion';
import { ComponentBubbleForce } from './forces/componentBubble';
import { CenterGravityForce } from './forces/centerGravity';
import { FastSpatialHash } from './spatialHash';
import { createIntegratorState, integrate } from './integrator';

// ─── Deterministic PRNG (xoshiro128**) ────────────────────────────────────────

class SeededRNG {
  private s0: number; private s1: number;
  private s2: number; private s3: number;

  constructor(seed: number) {
    let s = seed | 0;
    const sm = (): number => {
      s = (s + 0x9e3779b9) | 0;
      let t = s ^ (s >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      return (t ^ (t >>> 15)) >>> 0;
    };
    this.s0 = sm(); this.s1 = sm(); this.s2 = sm(); this.s3 = sm();
  }

  next(): number {
    const result = Math.imul(this.s1 * 5, 7) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0; this.s3 ^= this.s1;
    this.s1 ^= this.s2; this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = (this.s3 << 11) | (this.s3 >>> 21);
    return (result >>> 0) / 4294967296;
  }

  range(min: number, max: number): number { return min + this.next() * (max - min); }
}

// ─── Community detection (Louvain-inspired) ───────────────────────────────────

function detectCommunities(
  nodeCount: number,
  nodeIds: number[],
  adjacency: Map<number, Set<number>>,
  edgeCount: number,
  rng: SeededRNG,
  priorCommunities?: Map<number, number>,
): Map<number, number> {
  const idToIdx = new Map<number, number>();
  for (let i = 0; i < nodeIds.length; i++) idToIdx.set(nodeIds[i], i);

  if (edgeCount === 0) {
    const r = new Map<number, number>();
    for (let i = 0; i < nodeIds.length; i++) r.set(nodeIds[i], i);
    return r;
  }

  const m2 = edgeCount * 2;
  const deg = new Float32Array(nodeCount);
  for (let i = 0; i < nodeIds.length; i++) deg[i] = adjacency.get(nodeIds[i])?.size ?? 0;

  const nodeCommunity = new Int32Array(nodeCount);
  if (priorCommunities && priorCommunities.size > 0) {
    const priorIdRemap = new Map<number, number>();
    let nextPriorId = 0;
    for (let i = 0; i < nodeCount; i++) {
      const pc = priorCommunities.get(nodeIds[i]);
      if (pc !== undefined) {
        if (!priorIdRemap.has(pc)) priorIdRemap.set(pc, nextPriorId++);
        nodeCommunity[i] = priorIdRemap.get(pc)!;
      } else {
        nodeCommunity[i] = nextPriorId++;
      }
    }
  } else {
    for (let i = 0; i < nodeCount; i++) nodeCommunity[i] = i;
  }

  const communityDegSum = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) communityDegSum[nodeCommunity[i]] += deg[i];

  const hasWarmStart = priorCommunities && priorCommunities.size > 0;
  const basePasses = hasWarmStart ? 6 : 20;
  const maxPasses = nodeCount > 2000
    ? Math.max(3, Math.min(basePasses, Math.ceil(8000 / nodeCount)))
    : basePasses;

  const shuffled = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) shuffled[i] = i;
  const shuffle = (): void => {
    for (let i = nodeCount - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
  };

  const neighborComm = new Map<number, number>();
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false; let totalGain = 0;
    shuffle();
    for (let si = 0; si < nodeCount; si++) {
      const i = shuffled[si];
      const nodeId = nodeIds[i];
      const neighbors = adjacency.get(nodeId);
      if (!neighbors || neighbors.size === 0) continue;

      const currentComm = nodeCommunity[i];
      const ki = deg[i];

      neighborComm.clear();
      let edgesToCurrentComm = 0;
      for (const nId of neighbors) {
        const nIdx = idToIdx.get(nId);
        if (nIdx === undefined) continue;
        const nc = nodeCommunity[nIdx];
        neighborComm.set(nc, (neighborComm.get(nc) ?? 0) + 1);
        if (nc === currentComm) edgesToCurrentComm++;
      }

      const sigmaCurrentWithout = communityDegSum[currentComm] - ki;
      const removeLoss = edgesToCurrentComm / m2 - (ki * sigmaCurrentWithout) / (m2 * m2);

      let bestComm = currentComm, bestGain = 0;
      for (const [candidateComm, edgesToCandidate] of neighborComm) {
        if (candidateComm === currentComm) continue;
        const netGain = edgesToCandidate / m2 - (ki * communityDegSum[candidateComm]) / (m2 * m2) - removeLoss;
        if (netGain > bestGain) { bestGain = netGain; bestComm = candidateComm; }
      }

      if (bestComm !== currentComm && bestGain > 1e-10) {
        communityDegSum[currentComm] -= ki;
        nodeCommunity[i] = bestComm;
        communityDegSum[bestComm] += ki;
        improved = true; totalGain += bestGain;
      }
    }
    if (!improved || totalGain < 1e-6) break;
  }

  const commRemap = new Map<number, number>();
  let nextId = 0;
  for (let i = 0; i < nodeCount; i++) {
    const c = nodeCommunity[i];
    if (!commRemap.has(c)) commRemap.set(c, nextId++);
  }

  const result = new Map<number, number>();
  for (let i = 0; i < nodeCount; i++) result.set(nodeIds[i], commRemap.get(nodeCommunity[i])!);
  return result;
}

// ─── Connected components (BFS) ───────────────────────────────────────────────

function findConnectedComponents(
  nodeIds: number[],
  adjacency: Map<number, Set<number>>,
): Map<number, number> {
  const component = new Map<number, number>();
  let componentId = 0;
  const visited = new Set<number>();
  const queue: number[] = [];

  for (const startId of nodeIds) {
    if (visited.has(startId)) continue;
    queue.length = 0; queue.push(startId); visited.add(startId);
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      component.set(nodeId, componentId);
      const neighbors = adjacency.get(nodeId);
      if (neighbors) {
        for (const nId of neighbors) {
          if (!visited.has(nId)) { visited.add(nId); queue.push(nId); }
        }
      }
    }
    componentId++;
  }
  return component;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class SGEEngine {
  config: SGEConfig;
  private rng: SeededRNG;

  // Node count
  n = 0;
  private cap = 0;

  // Motion slab
  posX:  Float32Array = new Float32Array(0);
  posY:  Float32Array = new Float32Array(0);
  velX:  Float32Array = new Float32Array(0);
  velY:  Float32Array = new Float32Array(0);

  // Force ping-pong
  axBuf: Float32Array = new Float32Array(0);
  ayBuf: Float32Array = new Float32Array(0);
  oldAx: Float32Array = new Float32Array(0);
  oldAy: Float32Array = new Float32Array(0);

  // Per-node metadata
  pinnedArr:  Uint8Array   = new Uint8Array(0);
  clIdArr:    Int32Array   = new Int32Array(0);
  compIdArr:  Int32Array   = new Int32Array(0);
  degArr:     Int32Array   = new Int32Array(0);
  iRadArr:    Float32Array = new Float32Array(0);
  nodeIdArr:  Int32Array   = new Int32Array(0);
  activeNodeIndices: Int32Array = new Int32Array(0);
  activeCount = 0;

  // Pre-resolved edge arrays
  edgeSrc:     Int32Array   = new Int32Array(0);
  edgeTgt:     Int32Array   = new Int32Array(0);
  edgeRest:    Float32Array = new Float32Array(0);
  edgeStiff:   Float32Array = new Float32Array(0);
  edgeCompress: Float32Array = new Float32Array(0);
  numEdges = 0;

  // Cluster centroid arrays
  clCx:    Float32Array = new Float32Array(0);
  clCy:    Float32Array = new Float32Array(0);
  clCount: Int32Array   = new Int32Array(0);
  clFx:    Float32Array = new Float32Array(0);
  clFy:    Float32Array = new Float32Array(0);
  bigClusterBuf: Int32Array = new Int32Array(0);
  bigClusterCount = 0;

  // Sub-systems
  spatialHash = new FastSpatialHash(500, 512);

  // Topology
  private edges: SGEEdge[] = [];
  private adjacency = new Map<number, Set<number>>();
  private nodeIndex = new Map<number, number>();
  private componentMap = new Map<number, number>();
  private clusterMap = new Map<number, number>();

  // Simulation state
  energy = Infinity;
  ticks = 0;
  private integratorState = createIntegratorState({} as SGEConfig);

  // Forces
  private forces: ForcePlugin[] = [];

  constructor(nodes: SGENode[], edges: SGEEdge[], config: SGEConfig) {
    this.config = config;
    this.rng = new SeededRNG(config.seed);
    this.integratorState = createIntegratorState(config);
    this.spatialHash = new FastSpatialHash(config.localRepelRadius, 512);
    this._initForces();
    this.setTopology(nodes, edges);
  }

  private _initForces(): void {
    this.forces = [
      new SpringForce(),
      new LocalRepelForce(),
      new ClusterCohesionForce(),
      new ClusterRepulsionForce(),
      new ComponentBubbleForce(),
      new CenterGravityForce(),
    ];
  }

  // ─── Memory ─────────────────────────────────────────────────────────────────

  private ensureCap(needed: number): void {
    if (needed <= this.cap) return;
    const c = Math.max(needed, 256);
    const old = this.cap;

    const motBuf = new ArrayBuffer(4 * c * 4);
    const posX = new Float32Array(motBuf, 0 * c * 4, c);
    const posY = new Float32Array(motBuf, 1 * c * 4, c);
    const velX = new Float32Array(motBuf, 2 * c * 4, c);
    const velY = new Float32Array(motBuf, 3 * c * 4, c);
    if (old > 0) {
      posX.set(this.posX.subarray(0, old)); posY.set(this.posY.subarray(0, old));
      velX.set(this.velX.subarray(0, old)); velY.set(this.velY.subarray(0, old));
    }
    this.posX = posX; this.posY = posY;
    this.velX = velX; this.velY = velY;

    const pingBuf = new ArrayBuffer(2 * c * 4);
    const axBuf = new Float32Array(pingBuf, 0, c);
    const ayBuf = new Float32Array(pingBuf, c * 4, c);
    const pongBuf = new ArrayBuffer(2 * c * 4);
    const oldAx = new Float32Array(pongBuf, 0, c);
    const oldAy = new Float32Array(pongBuf, c * 4, c);
    if (old > 0) {
      axBuf.set(this.axBuf.subarray(0, old)); ayBuf.set(this.ayBuf.subarray(0, old));
      oldAx.set(this.oldAx.subarray(0, old)); oldAy.set(this.oldAy.subarray(0, old));
    }
    this.axBuf = axBuf; this.ayBuf = ayBuf;
    this.oldAx = oldAx; this.oldAy = oldAy;

    const grow = <T extends Float32Array | Int32Array | Uint8Array>(oldArr: T, Ctor: new (n: number) => T): T => {
      const a = new Ctor(c);
      (a as unknown as Float32Array).set(oldArr as unknown as Float32Array);
      return a;
    };

    this.pinnedArr = grow(this.pinnedArr, Uint8Array);
    this.clIdArr   = grow(this.clIdArr, Int32Array);
    this.compIdArr = grow(this.compIdArr, Int32Array);
    this.degArr    = grow(this.degArr, Int32Array);
    this.iRadArr   = grow(this.iRadArr, Float32Array);
    this.nodeIdArr = grow(this.nodeIdArr, Int32Array);
    this.activeNodeIndices = new Int32Array(Math.max(c, 256));

    this.cap = c;
  }

  private ensureClusterCap(k: number): void {
    if (this.clCx.length >= k) return;
    const c = Math.max(k, 128);
    this.clCx = new Float32Array(c);
    this.clCy = new Float32Array(c);
    this.clCount = new Int32Array(c);
    this.clFx = new Float32Array(c);
    this.clFy = new Float32Array(c);
    this.bigClusterBuf = new Int32Array(c);
  }

  // ─── Topology ───────────────────────────────────────────────────────────────

  setTopology(nodes: SGENode[], edges: SGEEdge[]): void {
    const N = nodes.length;
    this.ensureCap(N);
    this.n = N;

    // Preserve positions of nodes that survive a topology change so that
    // toggling filters or changing levels does not throw away the layout.
    const oldPositions = new Map<number, { x: number; y: number }>();
    for (const [id, idx] of this.nodeIndex) {
      oldPositions.set(id, { x: this.posX[idx], y: this.posY[idx] });
    }

    this.adjacency.clear();
    this.nodeIndex.clear();
    for (const nd of nodes) this.adjacency.set(nd.id, new Set());

    this.edges = [];
    let edgeCount = 0;
    const nodeIdSet = new Set(nodes.map(nd => nd.id));
    for (const e of edges) {
      if (nodeIdSet.has(e.source) && nodeIdSet.has(e.target) && e.source !== e.target) {
        this.edges.push({ source: e.source, target: e.target, type: e.type, weight: e.weight });
        this.adjacency.get(e.source)!.add(e.target);
        this.adjacency.get(e.target)!.add(e.source);
        edgeCount++;
      }
    }

    const nodeIds = nodes.map(nd => nd.id);
    this.componentMap = findConnectedComponents(nodeIds, this.adjacency);
    const priorClusters = this.clusterMap.size > 0 ? this.clusterMap : undefined;
    this.clusterMap = detectCommunities(N, nodeIds, this.adjacency, edgeCount, this.rng, priorClusters);

    for (let i = 0; i < N; i++) {
      const inp = nodes[i];
      this.nodeIdArr[i] = inp.id;
      this.posX[i] = 0; this.posY[i] = 0;
      this.velX[i] = 0; this.velY[i] = 0;
      this.oldAx[i] = 0; this.oldAy[i] = 0;
      this.pinnedArr[i] = inp.pinned ? 1 : 0;
      this.clIdArr[i] = this.clusterMap.get(inp.id) ?? 0;
      this.compIdArr[i] = this.componentMap.get(inp.id) ?? 0;
      this.degArr[i] = this.adjacency.get(inp.id)?.size ?? 0;
      this.iRadArr[i] = 0;
      this.nodeIndex.set(inp.id, i);
    }

    this._computeInitialPositions();
    for (let i = 0; i < N; i++) {
      const inp = nodes[i];
      const old = oldPositions.get(inp.id);
      const explicitX = inp.x !== undefined && inp.x !== 0;
      const explicitY = inp.y !== undefined && inp.y !== 0;
      if (explicitX) {
        this.posX[i] = inp.x!;
      } else if (old) {
        this.posX[i] = old.x;
      }
      if (explicitY) {
        this.posY[i] = inp.y!;
      } else if (old) {
        this.posY[i] = old.y;
      }
    }

    this._rebuildEdgeArrays();
    this._rebuildActiveIndices();
    this._updateClusterData();

    // Re-initialize forces with new topology
    for (const f of this.forces) f.initialize(this);


  }

  private _rebuildEdgeArrays(): void {
    const E = this.edges.length;
    const cap = Math.max(E * 2, 64);
    if (this.edgeSrc.length < E) {
      this.edgeSrc     = new Int32Array(cap);
      this.edgeTgt     = new Int32Array(cap);
      this.edgeRest    = new Float32Array(cap);
      this.edgeStiff   = new Float32Array(cap);
      this.edgeCompress = new Float32Array(cap);
    }
    const deg = this.degArr;
    const rest0 = this.config.idealDistance;
    const clId = this.clIdArr;
    let valid = 0;
    for (const e of this.edges) {
      const si = this.nodeIndex.get(e.source);
      const ti = this.nodeIndex.get(e.target);
      if (si === undefined || ti === undefined) continue;
      const maxDeg = Math.max(deg[si], deg[ti], 1);
      const isInterCluster = clId[si] !== clId[ti];
      const type = e.type || 'reference';
      const restMult = LINK_REST_MULT[type] ?? 1.0;
      const stiffMult = LINK_STIFF_MULT[type] ?? 1.0;
      const compressMult = LINK_COMPRESS_MULT[type] ?? 1.0;
      this.edgeSrc[valid]     = si;
      this.edgeTgt[valid]     = ti;
      this.edgeRest[valid]    = (isInterCluster ? rest0 * 1.6 : rest0) * restMult;
      const stiffScale = this.config.linkCountAttraction ? 1 / Math.sqrt(maxDeg) : 1 / maxDeg;
      this.edgeStiff[valid]   = stiffScale * (isInterCluster ? 0.7 : 1.0) * stiffMult;
      this.edgeCompress[valid] = compressMult;
      valid++;
    }
    this.numEdges = valid;
  }

  private _rebuildActiveIndices(): void {
    const N = this.n;
    const pin = this.pinnedArr;
    let count = 0;
    for (let i = 0; i < N; i++) {
      if (!pin[i]) this.activeNodeIndices[count++] = i;
    }
    this.activeCount = count;
  }

  // ─── Initial positions ──────────────────────────────────────────────────────

  private _computeInitialPositions(): void {
    const cfg = this.config, rng = this.rng, N = this.n;

    const componentGroups = new Map<number, number[]>();
    for (let i = 0; i < N; i++) {
      const cId = this.compIdArr[i];
      let g = componentGroups.get(cId);
      if (!g) { g = []; componentGroups.set(cId, g); }
      g.push(i);
    }

    const componentIds = [...componentGroups.keys()].sort(
      (a, b) => (componentGroups.get(b)?.length ?? 0) - (componentGroups.get(a)?.length ?? 0),
    );

    let componentAngle = 0;
    for (let ci = 0; ci < componentIds.length; ci++) {
      const cId = componentIds[ci];
      const nodeIndices = componentGroups.get(cId)!;
      let compCX = 0, compCY = 0;
      if (ci > 0) {
        const r = cfg.componentSpacing * Math.sqrt(ci);
        compCX = r * Math.cos(componentAngle);
        compCY = r * Math.sin(componentAngle);
        componentAngle += 2.399963;
      }

      const clusterGroups = new Map<number, number[]>();
      for (const idx of nodeIndices) {
        const kId = this.clIdArr[idx];
        let cg = clusterGroups.get(kId);
        if (!cg) { cg = []; clusterGroups.set(kId, cg); }
        cg.push(idx);
      }

      const clIds = [...clusterGroups.keys()].sort(
        (a, b) => (clusterGroups.get(b)?.length ?? 0) - (clusterGroups.get(a)?.length ?? 0),
      );

      let clusterAngle = rng.next() * Math.PI * 2;
      for (let ki = 0; ki < clIds.length; ki++) {
        const members = clusterGroups.get(clIds[ki])!;
        let clCX = compCX, clCY = compCY;
        if (ki > 0) {
          const r = cfg.clusterSpacing * Math.sqrt(ki);
          clCX = compCX + r * Math.cos(clusterAngle);
          clCY = compCY + r * Math.sin(clusterAngle);
          clusterAngle += 2.399963;
        }

        const goldenAngle = 2.399963229728653;
        const spiralAngle0 = rng.next() * Math.PI * 2;
        for (let ni = 0; ni < members.length; ni++) {
          const idx = members[ni];
          const r = cfg.idealDistance * 0.5 * Math.sqrt(ni + 1);
          const angle = spiralAngle0 + ni * goldenAngle;
          this.posX[idx] = clCX + r * Math.cos(angle);
          this.posY[idx] = clCY + r * Math.sin(angle);
          this.iRadArr[idx] = r;
        }
      }
    }
  }

  // ─── Cluster data ───────────────────────────────────────────────────────────

  private _updateClusterData(): void {
    const N = this.n;
    const clId = this.clIdArr;
    let maxClId = 0;
    for (let i = 0; i < N; i++) { if (clId[i] > maxClId) maxClId = clId[i]; }
    const K = maxClId + 1;
    this.ensureClusterCap(K);

    const cx = this.clCx, cy = this.clCy, cc = this.clCount;
    cx.fill(0, 0, K); cy.fill(0, 0, K); cc.fill(0, 0, K);

    for (let i = 0; i < N; i++) {
      const c = clId[i]; cx[c] += this.posX[i]; cy[c] += this.posY[i]; cc[c]++;
    }

    let bigCount = 0;
    for (let i = 0; i < K; i++) {
      if (cc[i] > 0) {
        cx[i] /= cc[i]; cy[i] /= cc[i];
        if (cc[i] > 1) this.bigClusterBuf[bigCount++] = i;
      }
    }
    this.bigClusterCount = bigCount;
  }

  // ─── Simulation step ────────────────────────────────────────────────────────

  step(): void {
    if (this.n === 0) return;

    this._updateClusterData();

    // Apply forces
    for (const f of this.forces) {
      f.apply(1.0);
    }

    // Integrate
    this.energy = integrate(
      this.integratorState,
      this.config,
      this.n,
      this.activeCount,
      this.activeNodeIndices,
      this.posX, this.posY,
      this.velX, this.velY,
      this.axBuf, this.ayBuf,
      this.oldAx, this.oldAy,
    );
    this.ticks++;

    // Swap force buffers O(1) + zero scratch with native fill
    const tmpAx = this.axBuf; this.axBuf = this.oldAx; this.oldAx = tmpAx;
    const tmpAy = this.ayBuf; this.ayBuf = this.oldAy; this.oldAy = tmpAy;
    this.axBuf.fill(0, 0, this.n);
    this.ayBuf.fill(0, 0, this.n);


  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  getState(): SGEState {
    return {
      posX: this.posX.subarray(0, this.n),
      posY: this.posY.subarray(0, this.n),
      velX: this.velX.subarray(0, this.n),
      velY: this.velY.subarray(0, this.n),
      nodeIdArr: this.nodeIdArr.subarray(0, this.n),
      nodeCount: this.n,
      energy: this.energy,
      ticks: this.ticks,
    };
  }

  pinNode(id: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx !== undefined) {
      this.pinnedArr[idx] = 1;
      this._rebuildActiveIndices();
    }
  }

  unpinNode(id: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx !== undefined) {
      this.pinnedArr[idx] = 0;
      this.velX[idx] = 0; this.velY[idx] = 0;
      this._rebuildActiveIndices();
    }
  }

  isPinned(id: number): boolean {
    const idx = this.nodeIndex.get(id);
    return idx !== undefined && this.pinnedArr[idx] === 1;
  }

  moveNode(id: number, x: number, y: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx !== undefined) { this.posX[idx] = x; this.posY[idx] = y; }
  }

  setConfig(partial: Partial<SGEConfig>): void {
    Object.assign(this.config, partial);
    if (partial.localRepelRadius !== undefined) this.spatialHash.setCellSize(partial.localRepelRadius);
    if (partial.seed !== undefined) this.rng = new SeededRNG(partial.seed);
    if (partial.linkCountAttraction !== undefined) this._rebuildEdgeArrays();
  }

  applyForce(id: number, fx: number, fy: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx === undefined || this.pinnedArr[idx]) return;
    this.axBuf[idx] += fx;
    this.ayBuf[idx] += fy;
  }

  getNodePosition(id: number): { x: number; y: number } | undefined {
    const idx = this.nodeIndex.get(id);
    if (idx === undefined) return undefined;
    return { x: this.posX[idx], y: this.posY[idx] };
  }

  dispose(): void {
    this.n = 0;
    this.edges = [];
    this.adjacency.clear();
    this.nodeIndex.clear();
  }
}
