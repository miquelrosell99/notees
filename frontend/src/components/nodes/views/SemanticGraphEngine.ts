/**
 * SemanticGraphEngine — high-performance force-directed layout engine.
 *
 * Architecture
 * ─────────────
 * • Full Structure-of-Arrays (SoA) Float32 physics data — cache-line friendly.
 * • Open-addressing typed-array spatial hash — replaces Map-based grid.
 * • Pre-resolved edge index arrays — eliminates 2E Map lookups per step.
 * • Barnes–Hut quadtree for O(K log K) inter-cluster repulsion.
 * • Fixed-timestep integration driven by the caller (graphPhysicsWorker).
 * • SGEState exposes raw typed-array views — zero-copy to worker postFrame.
 *
 * Zero external dependencies. Renderer-agnostic.
 */

// ─── Public types ──────────────────────────────────────────────────────────────

export interface SGEEdge {
  source: number;
  target: number;
}

export interface SGEConfig {
  seed: number;
  springStrength: number;
  idealDistance: number;
  clusterStrength: number;
  clusterRepelStrength: number;
  clusterSpacing: number;
  localRepelStrength: number;
  localRepelRadius: number;
  radialStrength: number;
  componentCenterStrength: number;
  componentSpacing: number;
  damping: number;
  maxVelocity: number;
  alpha: number;
  alphaDecay: number;
  alphaMin: number;
  reheatFactor: number;
  dt: number;
  /** Barnes–Hut opening criterion. Lower = more accurate, slower. Default 0.8 */
  bhTheta: number;
}

/** Typed-array views into the SoA physics state. All valid for [0..nodeCount). */
export interface SGEState {
  posX: Float32Array;
  posY: Float32Array;
  velX: Float32Array;
  velY: Float32Array;
  /** Node IDs in the same order as posX/posY. */
  nodeIdArr: Int32Array;
  nodeCount: number;
  alpha: number;
  energy: number;
  running: boolean;
  ticks: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function nextPow2(v: number): number {
  let n = 1;
  while (n < v) n <<= 1;
  return n;
}

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

// ─── Typed-array Robin Hood spatial hash ─────────────────────────────────────
//
// Each slot stores (cellKey, chainHead, PSL).  Multiple nodes in the same cell
// are chained via next[nodeIdx].  The PSL (probe sequence length) is stored as
// an Int8Array where -1 marks an empty slot.
//
// Robin Hood invariant: every occupied slot's stored PSL equals the distance
// from its ideal home slot, kept ≥ its neighbours.  On insert we steal a slot
// whenever our PSL exceeds the incumbent's, then re-home the evicted entry.
// This caps the maximum probe chain to O(log N) in practice vs O(N) for linear
// probing at load >0.7.  Table size is always ≥3N so load ≤0.33.
//
// Insert is two-phase:
//   Phase 1 – Robin Hood lookup: if targetKey already has a slot, prepend node.
//   Phase 2 – Robin Hood insert: key absent, create new (key, head) entry.
// Query gets a free early-exit: if tblPSL[slot] < currentPSL, key is absent.

class FastSpatialHash {
  private invCell: number;
  private mask = 0;
  private tblKey:  Int32Array = new Int32Array(0);  // cell-key at each slot
  private tblHead: Int32Array = new Int32Array(0);  // chain head (node index)
  private tblPSL:  Int8Array  = new Int8Array(0);   // probe sequence length; -1 = empty
  private next:    Int32Array = new Int32Array(0);   // per-node linked list
  resultBuf: Int32Array = new Int32Array(256);

  constructor(cellSize: number, capacity: number) {
    this.invCell = 1 / cellSize;
    this._alloc(capacity);
  }

  private _alloc(n: number): void {
    const sz     = nextPow2(Math.max(n * 3, 64));
    this.mask    = sz - 1;
    this.tblKey  = new Int32Array(sz).fill(-1);
    this.tblHead = new Int32Array(sz).fill(-1);
    this.tblPSL  = new Int8Array(sz).fill(-1);   // -1 = empty sentinel
    if (this.next.length < n) this.next = new Int32Array(Math.max(n * 2, 256)).fill(-1);
  }

  setCellSize(size: number): void { this.invCell = 1 / size; }

  /** Reset for a new frame. O(tableSize), not O(N). */
  clear(n: number): void {
    const sz = this.mask + 1;
    if (n * 3 > sz) {
      this._alloc(n);
    } else {
      this.tblKey.fill(-1,  0, sz);
      this.tblHead.fill(-1, 0, sz);
      this.tblPSL.fill(-1,  0, sz);
    }
    if (this.next.length < n) this.next = new Int32Array(Math.max(n * 2, 256)).fill(-1);
    this.next.fill(-1, 0, n);
  }

  private cellKey(cx: number, cy: number): number {
    return ((cx * 73856093) ^ (cy * 19349663)) | 0;
  }

  insert(idx: number, x: number, y: number): void {
    const cx  = Math.floor(x * this.invCell) | 0;
    const cy  = Math.floor(y * this.invCell) | 0;
    const targetKey = this.cellKey(cx, cy);
    const mask    = this.mask;
    const tblKey  = this.tblKey;
    const tblHead = this.tblHead;
    const tblPSL  = this.tblPSL;
    const next    = this.next;

    // ── Phase 1: Robin Hood lookup ──────────────────────────────────────────
    // If targetKey already has a slot, prepend idx to its chain and return.
    // Robin Hood early exit: if stored PSL < our probe distance, key is absent.
    {
      let slot = (targetKey >>> 0) & mask;
      let psl  = 0;
      for (;;) {
        const sp = tblPSL[slot];
        if (sp < 0 || sp < psl) break;          // empty or RH early-exit → key absent
        if (tblKey[slot] === targetKey) {         // cell already in table
          next[idx]     = tblHead[slot];
          tblHead[slot] = idx;
          return;
        }
        slot = (slot + 1) & mask;
        psl++;
      }
    }

    // ── Phase 2: Robin Hood insert ──────────────────────────────────────────
    // Key absent — create a new (targetKey, idx) entry using Robin Hood steal.
    // next[idx] is already -1 from clear(), so it becomes a single-node chain.
    {
      let probeKey : number = targetKey;
      let probeHead: number = idx;
      let psl      : number = 0;
      let slot = (targetKey >>> 0) & mask;
      for (;;) {
        const sp = tblPSL[slot];
        if (sp < 0) {                             // empty slot — place here
          tblKey[slot]  = probeKey;
          tblHead[slot] = probeHead;
          tblPSL[slot]  = psl;
          return;
        }
        if (sp < psl) {                           // Robin Hood: steal from rich
          const tmpK    = tblKey[slot];  tblKey[slot]  = probeKey;  probeKey  = tmpK;
          const tmpH    = tblHead[slot]; tblHead[slot] = probeHead; probeHead = tmpH;
          tblPSL[slot]  = psl;           psl           = sp;
        }
        slot = (slot + 1) & mask;
        psl++;
      }
    }
  }

  /** Fill resultBuf with all nodes in the 3×3 cell neighbourhood. Returns count. */
  queryInto(x: number, y: number): number {
    const cx      = Math.floor(x * this.invCell) | 0;
    const cy      = Math.floor(y * this.invCell) | 0;
    const mask    = this.mask;
    const tblKey  = this.tblKey;
    const tblHead = this.tblHead;
    const tblPSL  = this.tblPSL;
    const next    = this.next;
    let count = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k    = this.cellKey(cx + dx, cy + dy);
        let   slot = (k >>> 0) & mask;
        let   psl  = 0;
        for (;;) {
          const sp = tblPSL[slot];
          if (sp < 0 || sp < psl) break;         // empty or RH early-exit
          if (tblKey[slot] === k) {
            let cur = tblHead[slot];
            while (cur !== -1) {
              if (count >= this.resultBuf.length) {
                const nb = new Int32Array(this.resultBuf.length * 2);
                nb.set(this.resultBuf.subarray(0, count));
                this.resultBuf = nb;
              }
              this.resultBuf[count++] = cur;
              cur = next[cur];
            }
            break;
          }
          slot = (slot + 1) & mask;
          psl++;
        }
      }
    }
    return count;
  }
}

// ─── Barnes–Hut quadtree for cluster repulsion ────────────────────────────────
//
// Used when bigK ≥ BH_THRESHOLD.  Below that, direct O(K²) is cheaper.
// Pool-based: no heap allocation after the first build.
//
// Per-node layout:
//   Floats (stride BHNF=4): cx, cy, mass, halfSize
//   Ints   (stride BHNI=5): child0, child1, child2, child3, leafClusterIdx

const BH_THRESHOLD = 32;
const BHNF = 4;
const BHNI = 5;

class BHQuadTree {
  private poolF: Float32Array;
  private poolI: Int32Array;
  private size = 0;
  private cap:   number;

  constructor(initialCap: number) {
    this.cap   = Math.max(initialCap * 4, 128);
    this.poolF = new Float32Array(this.cap * BHNF);
    this.poolI = new Int32Array(this.cap * BHNI).fill(-1);
  }

  private _grow(): void {
    this.cap *= 2;
    const nf = new Float32Array(this.cap * BHNF); nf.set(this.poolF); this.poolF = nf;
    const ni = new Int32Array(this.cap * BHNI).fill(-1); ni.set(this.poolI); this.poolI = ni;
  }

  private _alloc(cx: number, cy: number, mass: number, halfSize: number, leafIdx: number): number {
    if (this.size >= this.cap) this._grow();
    const n = this.size++;
    const f = n * BHNF; const ii = n * BHNI;
    this.poolF[f    ] = cx;
    this.poolF[f + 1] = cy;
    this.poolF[f + 2] = mass;
    this.poolF[f + 3] = halfSize;
    this.poolI[ii    ] = -1; this.poolI[ii + 1] = -1;
    this.poolI[ii + 2] = -1; this.poolI[ii + 3] = -1;
    this.poolI[ii + 4] = leafIdx;
    return n;
  }

  /** Build tree from bigIds[0..bigK). */
  build(
    cx: Float32Array, cy: Float32Array, cc: Int32Array,
    bigIds: Int32Array, bigK: number,
  ): number {
    this.size = 0;
    if (bigK === 0) return -1;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < bigK; i++) {
      const c = bigIds[i];
      if (cx[c] < minX) minX = cx[c]; if (cx[c] > maxX) maxX = cx[c];
      if (cy[c] < minY) minY = cy[c]; if (cy[c] > maxY) maxY = cy[c];
    }
    const hw  = Math.max(maxX - minX, maxY - minY) * 0.5 + 1;
    const rcx = (minX + maxX) * 0.5;
    const rcy = (minY + maxY) * 0.5;

    const root = this._alloc(rcx, rcy, 0, hw, -1);
    for (let i = 0; i < bigK; i++) this._insert(root, bigIds[i], cx, cy, cc);
    return root;
  }

  private _insert(
    node: number, clIdx: number,
    cx: Float32Array, cy: Float32Array, cc: Int32Array,
  ): void {
    const f  = node * BHNF; const ii = node * BHNI;
    const clx   = cx[clIdx], cly = cy[clIdx], clm = cc[clIdx];
    const oldM  = this.poolF[f + 2];
    const newM  = oldM + clm;
    this.poolF[f    ] = (this.poolF[f    ] * oldM + clx * clm) / newM;
    this.poolF[f + 1] = (this.poolF[f + 1] * oldM + cly * clm) / newM;
    this.poolF[f + 2] = newM;

    const leafIdx = this.poolI[ii + 4];
    const half    = this.poolF[f + 3];
    const quarter = half * 0.5;
    const ncx     = this.poolF[f    ];
    const ncy     = this.poolF[f + 1];

    if (leafIdx === -1 && this.poolI[ii] === -1) {
      // Currently empty internal node — place as leaf
      this.poolI[ii + 4] = clIdx;
      return;
    }

    if (leafIdx !== -1) {
      // Was a leaf — subdivide: push existing cluster into child
      this.poolI[ii + 4] = -1;
      const child = this._getOrCreateChild(node, leafIdx, cx, cy, ncx, ncy, quarter);
      const cf  = child * BHNF;
      this.poolF[cf + 2] = 0; // reset mass so re-insert calculates correctly
      this._insert(child, leafIdx, cx, cy, cc);
    }

    const child2 = this._getOrCreateChild(node, clIdx, cx, cy, ncx, ncy, quarter);
    this._insert(child2, clIdx, cx, cy, cc);
  }

  private _getOrCreateChild(
    node: number, clIdx: number,
    cx: Float32Array, cy: Float32Array,
    ncx: number, ncy: number, quarter: number,
  ): number {
    const ii      = node * BHNI;
    const clx     = cx[clIdx], cly = cy[clIdx];
    const quadrant = (clx >= ncx ? 1 : 0) | (cly >= ncy ? 2 : 0);

    let child = this.poolI[ii + quadrant];
    if (child === -1) {
      const ccx = ncx + (clx >= ncx ?  quarter : -quarter);
      const ccy = ncy + (cly >= ncy ?  quarter : -quarter);
      child = this._alloc(ccx, ccy, 0, quarter, -1);
      this.poolI[ii + quadrant] = child;
    }
    return child;
  }

  /**
   * Walk the tree and accumulate repulsion force on cluster aIdx into fxOut/fyOut.
   * theta2 = (bhTheta)². Lower = more accurate.
   */
  computeForce(
    root: number, aIdx: number,
    cx: Float32Array, cy: Float32Array, cc: Int32Array,
    repelStr: number, theta2: number,
    fxOut: Float32Array, fyOut: Float32Array,
  ): void {
    if (root === -1) return;
    this._traverse(root, aIdx, cx[aIdx], cy[aIdx], cc[aIdx], cx, cy, cc, repelStr, theta2, fxOut, fyOut);
  }

  private _traverse(
    node: number, aIdx: number,
    ax: number, ay: number, aMass: number,
    cx: Float32Array, cy: Float32Array, cc: Int32Array,
    repelStr: number, theta2: number,
    fxOut: Float32Array, fyOut: Float32Array,
  ): void {
    if (node === -1) return;
    const f  = node * BHNF; const ii = node * BHNI;
    const ncx      = this.poolF[f    ];
    const ncy      = this.poolF[f + 1];
    const nmass    = this.poolF[f + 2];
    const half     = this.poolF[f + 3];
    const leafIdx  = this.poolI[ii + 4];

    const dx = ax - ncx, dy = ay - ncy;
    const distSq = dx * dx + dy * dy;

    if (leafIdx !== -1) {
      if (leafIdx === aIdx || distSq < 0.01) return;
      const dist = Math.sqrt(distSq);
      const f_   = repelStr * Math.sqrt(aMass * nmass) / distSq;
      fxOut[aIdx] += (dx / dist) * f_;
      fyOut[aIdx] += (dy / dist) * f_;
      return;
    }

    // Barnes–Hut criterion: (2*half)² / distSq < theta²  →  use approximation
    const size2 = half * half * 4;
    if (size2 < theta2 * distSq) {
      if (distSq < 0.01 || nmass === 0) return;
      const dist = Math.sqrt(distSq);
      const f_   = repelStr * Math.sqrt(aMass * nmass) / distSq;
      fxOut[aIdx] += (dx / dist) * f_;
      fyOut[aIdx] += (dy / dist) * f_;
      return;
    }

    for (let q = 0; q < 4; q++) {
      this._traverse(this.poolI[ii + q], aIdx, ax, ay, aMass, cx, cy, cc, repelStr, theta2, fxOut, fyOut);
    }
  }
}

// Direct O(K²) for small K (cheaper than building BH tree)
function directClusterRepulsion(
  cx: Float32Array, cy: Float32Array, cc: Int32Array,
  bigIds: Int32Array, bigK: number,
  clFx: Float32Array, clFy: Float32Array,
  repelStr: number,
): void {
  for (let a = 0; a < bigK; a++) {
    const ai = bigIds[a];
    for (let b = a + 1; b < bigK; b++) {
      const bi = bigIds[b];
      const dx = cx[ai] - cx[bi], dy = cy[ai] - cy[bi];
      const distSq = dx * dx + dy * dy;
      if (distSq < 0.01) continue;
      const dist = Math.sqrt(distSq);
      const force = repelStr * Math.sqrt(cc[ai] * cc[bi]) / distSq;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      clFx[ai] += fx; clFy[ai] += fy;
      clFx[bi] -= fx; clFy[bi] -= fy;
    }
  }
}

// ─── Community Detection (Louvain-inspired) ───────────────────────────────────

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

  const communityInternalEdges = new Float64Array(nodeCount);
  const hasWarmStart = priorCommunities && priorCommunities.size > 0;
  const basePasses  = hasWarmStart ? 6 : 20;
  const maxPasses   = nodeCount > 2000
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
      const nodeId    = nodeIds[i];
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
        communityInternalEdges[currentComm] -= edgesToCurrentComm * 2;
        nodeCommunity[i] = bestComm;
        communityDegSum[bestComm] += ki;
        communityInternalEdges[bestComm] += (neighborComm.get(bestComm) ?? 0) * 2;
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

// ─── Connected Components (BFS) ───────────────────────────────────────────────

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

// ─── Default Configuration ────────────────────────────────────────────────────

const DEFAULT_CONFIG: SGEConfig = {
  seed: 42,
  springStrength: 0.06,
  idealDistance: 80,
  clusterStrength: 0.004,
  clusterRepelStrength: 800,
  clusterSpacing: 200,
  localRepelStrength: 3000,
  localRepelRadius: 500,
  radialStrength: 0.001,
  componentCenterStrength: 0.001,
  componentSpacing: 500,
  damping: 0.88,
  maxVelocity: 50,
  alpha: 1.0,
  alphaDecay: 0.002,
  alphaMin: 0.0005,
  reheatFactor: 0.3,
  dt: 1.0,
  bhTheta: 0.8,
};

// ─── SemanticGraphEngine ──────────────────────────────────────────────────────

export class SemanticGraphEngine {
  private config: SGEConfig;
  private rng: SeededRNG;

  // ── SoA physics arrays ─────────────────────────────────────────────────────────
  private n   = 0; // live node count
  private cap = 0; // allocation capacity

  // Motion slab: posX | posY | velX | velY — one ArrayBuffer.
  // integrate() touches all 4 per node; one slab keeps them in the same OS pages.
  private posX:  Float32Array = new Float32Array(0);
  private posY:  Float32Array = new Float32Array(0);
  private velX:  Float32Array = new Float32Array(0);
  private velY:  Float32Array = new Float32Array(0);

  // Force ping-pong pair — two independent ArrayBuffers so their pointers can be
  // swapped in O(1) after every integrate(), replacing N scatter-writes `oldAx[i]=nax`.
  // axBuf/ayBuf = current scratch (zeroed at end of integrate).
  // oldAx/oldAy = previous step's accelerations (read-only during integrate).
  private axBuf: Float32Array = new Float32Array(0);
  private ayBuf: Float32Array = new Float32Array(0);
  private oldAx: Float32Array = new Float32Array(0);
  private oldAy: Float32Array = new Float32Array(0);
  // Per-node metadata
  private pinnedArr:  Uint8Array   = new Uint8Array(0);
  private clIdArr:    Int32Array   = new Int32Array(0);
  private compIdArr:  Int32Array   = new Int32Array(0);
  private degArr:     Int32Array   = new Int32Array(0);
  private iRadArr:    Float32Array = new Float32Array(0);
  private nodeIdArr:  Int32Array   = new Int32Array(0);

  // ── Pre-resolved edge index arrays ─ rebuilt once per topology change ────────
  private edgeSrc:   Int32Array   = new Int32Array(0);
  private edgeTgt:   Int32Array   = new Int32Array(0);
  private edgeRest:  Float32Array = new Float32Array(0); // rest length per edge
  private edgeStiff: Float32Array = new Float32Array(0); // 1/√(maxDeg) per edge
  private numEdges = 0;

  // ── Active (unpinned) node index list ─ rebuilt on every pin-state change ────
  // Lets integrate() and force loops skip the branch entirely.
  private activeNodeIndices: Int32Array = new Int32Array(0);
  private activeCount = 0;

  // ── Topology (used only at init / incremental updates) ────────────────────── 
  private edges: SGEEdge[] = [];
  private adjacency  = new Map<number, Set<number>>();
  private nodeIndex  = new Map<number, number>();   // id → array index
  private componentMap = new Map<number, number>();
  private clusterMap   = new Map<number, number>();

  // ── Cluster centroid flat arrays (indexed by clusterId 0..K) ─────────────────
  private clCx:    Float32Array = new Float32Array(0);
  private clCy:    Float32Array = new Float32Array(0);
  private clCount: Int32Array   = new Int32Array(0);
  private clFx:    Float32Array = new Float32Array(0);
  private clFy:    Float32Array = new Float32Array(0);
  private bigClusterBuf:   Int32Array = new Int32Array(0);
  private bigClusterCount  = 0;

  // ── Component centroid arrays ─────────────────────────────────────────────────
  private ccX:    Float32Array = new Float32Array(0);
  private ccY:    Float32Array = new Float32Array(0);
  private ccCount: Int32Array  = new Int32Array(0);

  // ── Sub-systems ───────────────────────────────────────────────────────────────
  private spatialHash: FastSpatialHash;
  private bhTree = new BHQuadTree(64);

  // ── Simulation state ──────────────────────────────────────────────────────────
  private alpha    = 1.0;
  private energy   = Infinity;
  private running  = false;
  private frozen   = false;
  private ticks    = 0;
  private rafId    = 0;
  private prevDt:  number;
  private oscillationCounter = 0;
  private prevEnergy = Infinity;

  constructor(
    inputNodes: Array<{ id: number; x?: number; y?: number }>,
    inputEdges: SGEEdge[],
    config?: Partial<SGEConfig>,
  ) {
    this.config  = { ...DEFAULT_CONFIG, ...config };
    this.rng     = new SeededRNG(this.config.seed);
    this.prevDt  = this.config.dt;
    this.spatialHash = new FastSpatialHash(this.config.localRepelRadius, 512);
    this.initializeGraph(inputNodes, inputEdges);
  }

  // ─── Memory management ────────────────────────────────────────────────────────

  private _growTyped<T extends Float32Array | Int32Array | Uint8Array>(
    old: T, Ctor: new (n: number) => T, newCap: number,
  ): T {
    const a = new Ctor(newCap);
    (a as unknown as Float32Array).set(old as unknown as Float32Array);
    return a;
  }

  private _rebuildActiveIndices(): void {
    const N   = this.n;
    const pin = this.pinnedArr;
    if (this.activeNodeIndices.length < N) {
      this.activeNodeIndices = new Int32Array(Math.max(N, 256));
    }
    const idx = this.activeNodeIndices;
    let count = 0;
    for (let i = 0; i < N; i++) {
      if (!pin[i]) idx[count++] = i;
    }
    this.activeCount = count;
  }

  private ensureCap(needed: number): void {
    if (needed <= this.cap) return;
    const c   = Math.max(needed, 256);
    const old = this.cap;

    // ── Motion slab: posX | posY | velX | velY ────────────────────────────────
    // One ArrayBuffer so all 4 arrays are contiguous in physical memory.
    const motBuf = new ArrayBuffer(4 * c * 4);
    const posX   = new Float32Array(motBuf, 0 * c * 4, c);
    const posY   = new Float32Array(motBuf, 1 * c * 4, c);
    const velX   = new Float32Array(motBuf, 2 * c * 4, c);
    const velY   = new Float32Array(motBuf, 3 * c * 4, c);
    if (old > 0) {
      posX.set(this.posX.subarray(0, old)); posY.set(this.posY.subarray(0, old));
      velX.set(this.velX.subarray(0, old)); velY.set(this.velY.subarray(0, old));
    }
    this.posX = posX; this.posY = posY;
    this.velX = velX; this.velY = velY;

    // ── Force ping-pong: two independent pair-slabs (ax+ay each) ─────────────
    // Independent buffers let us swap pointers in O(1) after integrate().
    // Each slab stores ax then ay contiguously so both are on the same cache line
    // when forces are applied per node.
    const pingBuf = new ArrayBuffer(2 * c * 4);
    const axBuf   = new Float32Array(pingBuf, 0,       c);
    const ayBuf   = new Float32Array(pingBuf, c * 4,   c);
    const pongBuf = new ArrayBuffer(2 * c * 4);
    const oldAx   = new Float32Array(pongBuf, 0,       c);
    const oldAy   = new Float32Array(pongBuf, c * 4,   c);
    if (old > 0) {
      axBuf.set(this.axBuf.subarray(0, old)); ayBuf.set(this.ayBuf.subarray(0, old));
      oldAx.set(this.oldAx.subarray(0, old)); oldAy.set(this.oldAy.subarray(0, old));
    }
    this.axBuf = axBuf; this.ayBuf = ayBuf;
    this.oldAx = oldAx; this.oldAy = oldAy;

    // ── Per-node metadata (separate allocations — infrequently accessed) ──────
    this.pinnedArr = this._growTyped(this.pinnedArr,  Uint8Array,  c);
    this.clIdArr   = this._growTyped(this.clIdArr,   Int32Array,   c);
    this.compIdArr = this._growTyped(this.compIdArr, Int32Array,   c);
    this.degArr    = this._growTyped(this.degArr,    Int32Array,   c);
    this.iRadArr   = this._growTyped(this.iRadArr,   Float32Array, c);
    this.nodeIdArr = this._growTyped(this.nodeIdArr, Int32Array,   c);
    this.cap = c;
  }

  private ensureClusterCap(k: number): void {
    if (this.clCx.length >= k) return;
    const c = Math.max(k, 128);
    this.clCx    = new Float32Array(c);
    this.clCy    = new Float32Array(c);
    this.clCount = new Int32Array(c);
    this.clFx    = new Float32Array(c);
    this.clFy    = new Float32Array(c);
    this.bigClusterBuf = new Int32Array(c);
  }

  private ensureComponentCap(c: number): void {
    if (this.ccX.length >= c) return;
    const cc = Math.max(c, 64);
    this.ccX     = new Float32Array(cc);
    this.ccY     = new Float32Array(cc);
    this.ccCount = new Int32Array(cc);
  }

  // ─── Graph initialization ─────────────────────────────────────────────────────

  private initializeGraph(
    inputNodes: Array<{ id: number; x?: number; y?: number }>,
    inputEdges: SGEEdge[],
  ): void {
    const N = inputNodes.length;
    this.ensureCap(N);
    this.n = N;

    this.adjacency.clear();
    this.nodeIndex.clear();
    for (const nd of inputNodes) this.adjacency.set(nd.id, new Set());

    this.edges = [];
    let edgeCount = 0;
    const nodeIdSet = new Set(inputNodes.map(nd => nd.id));
    for (const e of inputEdges) {
      if (nodeIdSet.has(e.source) && nodeIdSet.has(e.target) && e.source !== e.target) {
        this.edges.push({ source: e.source, target: e.target });
        this.adjacency.get(e.source)!.add(e.target);
        this.adjacency.get(e.target)!.add(e.source);
        edgeCount++;
      }
    }

    const nodeIds = inputNodes.map(nd => nd.id);
    this.componentMap = findConnectedComponents(nodeIds, this.adjacency);
    const priorClusters = this.clusterMap.size > 0 ? this.clusterMap : undefined;
    this.clusterMap = detectCommunities(N, nodeIds, this.adjacency, edgeCount, this.rng, priorClusters);

    for (let i = 0; i < N; i++) {
      const inp = inputNodes[i];
      this.nodeIdArr[i]  = inp.id;
      this.posX[i]       = 0; this.posY[i]  = 0;
      this.velX[i]       = 0; this.velY[i]  = 0;
      this.oldAx[i]      = 0; this.oldAy[i] = 0;
      this.pinnedArr[i]  = 0;
      this.clIdArr[i]    = this.clusterMap.get(inp.id) ?? 0;
      this.compIdArr[i]  = this.componentMap.get(inp.id) ?? 0;
      this.degArr[i]     = this.adjacency.get(inp.id)?.size ?? 0;
      this.iRadArr[i]    = 0;
      this.nodeIndex.set(inp.id, i);
    }

    this._computeInitialPositions();

    // Apply user-provided position overrides
    for (let i = 0; i < N; i++) {
      const inp = inputNodes[i];
      if (inp.x !== undefined && inp.x !== 0) this.posX[i] = inp.x;
      if (inp.y !== undefined && inp.y !== 0) this.posY[i] = inp.y;
    }

    this._rebuildEdgeArrays();
    this._rebuildActiveIndices();
    this.updateClusterData();
  }

  private _rebuildEdgeArrays(): void {
    const E   = this.edges.length;
    const cap = Math.max(E * 2, 64);
    if (this.edgeSrc.length < E) {
      this.edgeSrc   = new Int32Array(cap);
      this.edgeTgt   = new Int32Array(cap);
      this.edgeRest  = new Float32Array(cap);
      this.edgeStiff = new Float32Array(cap);
    }
    const deg     = this.degArr;
    const rest0   = this.config.idealDistance;
    let valid = 0;
    for (const e of this.edges) {
      const si = this.nodeIndex.get(e.source);
      const ti = this.nodeIndex.get(e.target);
      if (si === undefined || ti === undefined) continue;
      const maxDeg = Math.max(deg[si], deg[ti], 1);
      this.edgeSrc[valid]   = si;
      this.edgeTgt[valid]   = ti;
      this.edgeRest[valid]  = rest0;
      this.edgeStiff[valid] = 1 / Math.sqrt(maxDeg);
      valid++;
    }
    this.numEdges = valid;
  }

  /** Fast path: only rest lengths changed (topology/stiffness unchanged). */
  private _rebuildEdgeRest(): void {
    const rest0 = this.config.idealDistance;
    const E     = this.numEdges;
    const eRest = this.edgeRest;
    for (let e = 0; e < E; e++) eRest[e] = rest0;
  }

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
          this.posX[idx]  = clCX + r * Math.cos(angle);
          this.posY[idx]  = clCY + r * Math.sin(angle);
          this.iRadArr[idx] = r;
        }
      }
    }
  }

  // ─── Cluster centroids ────────────────────────────────────────────────────────

  private updateClusterData(): void {
    const N    = this.n;
    const clId = this.clIdArr;
    let maxClId = 0;
    for (let i = 0; i < N; i++) { if (clId[i] > maxClId) maxClId = clId[i]; }
    const K = maxClId + 1;
    this.ensureClusterCap(K);

    const cx = this.clCx, cy = this.clCy, cc = this.clCount;
    cx.fill(0, 0, K); cy.fill(0, 0, K); cc.fill(0, 0, K);

    const posX = this.posX, posY = this.posY;
    for (let i = 0; i < N; i++) {
      const c = clId[i]; cx[c] += posX[i]; cy[c] += posY[i]; cc[c]++;
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

  // ─── Force computation ────────────────────────────────────────────────────────

  computeForces(): void {
    const N     = this.n;
    const cfg   = this.config;
    const alpha = this.alpha;
    const posX = this.posX, posY = this.posY;
    const pin  = this.pinnedArr;
    const clId = this.clIdArr, compId = this.compIdArr;
    const iRad = this.iRadArr;
    const ax = this.axBuf, ay = this.ayBuf;
    const activeIdx   = this.activeNodeIndices;
    const activeCount = this.activeCount;
    // ax/ay are already zeroed — cleared at the tail of the previous integrate().

    this.updateClusterData();
    const clCx = this.clCx, clCy = this.clCy, clCC = this.clCount;

    // ─ A) Intra-cluster cohesion (shell model) ─────────────────────────────────
    const clusterStr = cfg.clusterStrength * alpha;
    const idealDist  = cfg.idealDistance;
    for (let i = 0; i < N; i++) {
      if (pin[i]) continue;
      const c = clId[i]; const cnt = clCC[c];
      if (cnt <= 1) continue;
      const dx = posX[i] - clCx[c], dy = posY[i] - clCy[c];
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const shellR = idealDist * 0.5 * Math.sqrt(cnt);
      const err = dist - shellR;
      const f = (err > 0 ? -clusterStr * err : -clusterStr * err * 0.15) / dist;
      ax[i] += dx * f; ay[i] += dy * f;
    }

    // ─ B) Inter-cluster repulsion ─ Barnes–Hut or direct O(K²) ──────────────── 
    const bigIds   = this.bigClusterBuf, bigK = this.bigClusterCount;
    const clFx = this.clFx, clFy = this.clFy;
    const nScale   = N > 1 ? Math.sqrt(N) : 1;
    const repelStr = cfg.clusterRepelStrength * alpha * nScale;

    if (bigK > 0) {
      for (let i = 0; i < bigK; i++) { const c = bigIds[i]; clFx[c] = 0; clFy[c] = 0; }

      if (bigK >= BH_THRESHOLD) {
        const root   = this.bhTree.build(clCx, clCy, clCC, bigIds, bigK);
        const theta2 = cfg.bhTheta * cfg.bhTheta;
        for (let i = 0; i < bigK; i++) {
          this.bhTree.computeForce(root, bigIds[i], clCx, clCy, clCC, repelStr, theta2, clFx, clFy);
        }
      } else {
        directClusterRepulsion(clCx, clCy, clCC, bigIds, bigK, clFx, clFy, repelStr);
      }

      // Distribute forces to member nodes
      for (let k = 0; k < activeCount; k++) {
        const i = activeIdx[k];
        const c = clId[i]; const cnt = clCC[c];
        if (cnt <= 1) continue;
        ax[i] += clFx[c] / cnt; ay[i] += clFy[c] / cnt;
      }
    }

    // ─ C) Edge springs ─ pure arithmetic, no topology or derived math per step ─
    const springStr  = cfg.springStrength * alpha;
    const E          = this.numEdges;
    const eSrc       = this.edgeSrc,   eTgt   = this.edgeTgt;
    const eRest      = this.edgeRest,  eStiff = this.edgeStiff;
    for (let e = 0; e < E; e++) {
      const si = eSrc[e], ti = eTgt[e];
      const dx = posX[ti] - posX[si], dy = posY[ti] - posY[si];
      const dist  = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = springStr * eStiff[e] * (dist - eRest[e]);
      const fx = dx / dist * force, fy = dy / dist * force;
      if (!pin[si]) { ax[si] += fx; ay[si] += fy; }
      if (!pin[ti]) { ax[ti] -= fx; ay[ti] -= fy; }
    }

    // ─ D) Local repulsion ─ open-addressing typed-array spatial hash ─────────── 
    const baseRepelRadius = cfg.localRepelRadius;
    const repelRadius  = N > 1000 ? baseRepelRadius * Math.min(1, Math.sqrt(1000 / N)) : baseRepelRadius;
    const localStr     = cfg.localRepelStrength * alpha;
    const repelRadSq   = repelRadius * repelRadius;
    const invRepelRad  = 1 / repelRadius;

    const grid = this.spatialHash;
    grid.setCellSize(repelRadius);
    grid.clear(N);
    for (let i = 0; i < N; i++) grid.insert(i, posX[i], posY[i]);

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k];
      const nix = posX[i], niy = posY[i];
      const nCount = grid.queryInto(nix, niy);
      const nbuf   = grid.resultBuf;
      for (let q = 0; q < nCount; q++) {
        const j = nbuf[q];
        if (j <= i) continue;
        const dx = nix - posX[j], dy = niy - posY[j];
        const distSq = dx * dx + dy * dy;
        if (distSq >= repelRadSq || distSq < 0.01) continue;
        const dist = Math.sqrt(distSq);
        const t    = 1 - dist * invRepelRad;
        const env  = t * t * t * (t * (t * 6 - 15) + 10);
        const force = localStr * env / distSq;
        const fx = dx / dist * force, fy = dy / dist * force;
        ax[i] += fx; ay[i] += fy;
        if (!pin[j]) { ax[j] -= fx; ay[j] -= fy; }
      }
    }

    // ─ E) Radial stability ───────────────────────────────────────────────────── 
    const radialStr = cfg.radialStrength * alpha;
    if (radialStr > 0) {
      for (let k = 0; k < activeCount; k++) {
        const i = activeIdx[k];
        const c = clId[i]; if (clCC[c] === 0) continue;
        const dx = posX[i] - clCx[c], dy = posY[i] - clCy[c];
        const r = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = -radialStr * (r - iRad[i]) / r;
        ax[i] += dx * f; ay[i] += dy * f;
      }
    }

    // ─ F) Component gravity ────────────────────────────────────────────────────  
    const centerStr = cfg.componentCenterStrength * alpha;
    if (centerStr > 0) {
      let maxCompId = 0;
      for (let i = 0; i < N; i++) { if (compId[i] > maxCompId) maxCompId = compId[i]; }
      const C = maxCompId + 1;
      this.ensureComponentCap(C);
      const cpX = this.ccX, cpY = this.ccY, cpC = this.ccCount;
      cpX.fill(0, 0, C); cpY.fill(0, 0, C); cpC.fill(0, 0, C);
      for (let i = 0; i < N; i++) { const c = compId[i]; cpX[c] += posX[i]; cpY[c] += posY[i]; cpC[c]++; }
      for (let i = 0; i < C; i++) { if (cpC[i] > 0) { cpX[i] /= cpC[i]; cpY[i] /= cpC[i]; } }
      for (let k = 0; k < activeCount; k++) {
        const i = activeIdx[k];
        const c = compId[i];
        ax[i] -= centerStr * (posX[i] - cpX[c]);
        ay[i] -= centerStr * (posY[i] - cpY[c]);
      }
    }
  }

  // ─── Velocity Verlet integration ──────────────────────────────────────────────

  integrate(): void {
    const N = this.n, cfg = this.config;
    const dt = this.prevDt, hdt2 = 0.5 * dt * dt;
    const maxVel = cfg.maxVelocity, maxV2 = maxVel * maxVel;
    const damp = cfg.damping;

    // Motion slab locals (contiguous in memory).
    const posX = this.posX, posY = this.posY;
    const velX = this.velX, velY = this.velY;
    // Force ping-pong locals: ax=scratch (this step), oldAx=prev step.
    const ax    = this.axBuf, ay    = this.ayBuf;
    const oldAx = this.oldAx, oldAy = this.oldAy;
    const activeIdx   = this.activeNodeIndices;
    const activeCount = this.activeCount;
    let totalEnergy = 0;

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k];
      const oax = oldAx[i], oay = oldAy[i];
      const nax = ax[i],    nay = ay[i];
      posX[i] += velX[i] * dt + oax * hdt2;
      posY[i] += velY[i] * dt + oay * hdt2;
      let vx = (velX[i] + 0.5 * (oax + nax) * dt) * damp;
      let vy = (velY[i] + 0.5 * (oay + nay) * dt) * damp;
      const v2 = vx * vx + vy * vy;
      if (v2 > maxV2) { const s = maxVel / Math.sqrt(v2); vx *= s; vy *= s; }
      velX[i] = vx; velY[i] = vy;
      totalEnergy += vx * vx + vy * vy;
    }

    // ── Force buffer swap ────────────────────────────────────────────────────
    // Promote current scratch (ax/ay) → oldAx/oldAy for next Verlet step.
    // Demote spent oldAx/oldAy → fresh scratch. O(1) pointer swap replaces the
    // previous N scatter-writes `oldAx[i]=nax`.
    // Zero the freshly demoted scratch now while force buffer pages are still hot.
    this.oldAx = ax;   this.oldAy = ay;
    this.axBuf = oldAx; this.ayBuf = oldAy;
    this.axBuf.fill(0, 0, N); this.ayBuf.fill(0, 0, N);

    this.energy = N > 0 ? totalEnergy / N : 0;

    // Adaptive timestep: back off if diverging
    if (this.energy > this.prevEnergy * 1.1 && this.energy > 0.01) {
      if (++this.oscillationCounter > 3) {
        this.prevDt = Math.max(cfg.dt * 0.25, this.prevDt * 0.8);
        this.oscillationCounter = 0;
      }
    } else {
      this.oscillationCounter = 0;
      if (this.prevDt < cfg.dt) this.prevDt = Math.min(cfg.dt, this.prevDt * 1.02);
    }
    this.prevEnergy = this.energy;
    this.alpha += (0 - this.alpha) * cfg.alphaDecay;
    this.ticks++;
  }

  // ─── Public step/state API ────────────────────────────────────────────────────

  step(): void {
    if (this.frozen) return;
    this.computeForces();
    this.integrate();
  }

  getState(): SGEState {
    return {
      posX:      this.posX.subarray(0, this.n),
      posY:      this.posY.subarray(0, this.n),
      velX:      this.velX.subarray(0, this.n),
      velY:      this.velY.subarray(0, this.n),
      nodeIdArr: this.nodeIdArr.subarray(0, this.n),
      nodeCount: this.n,
      alpha:     this.alpha,
      energy:    this.energy,
      running:   this.running,
      ticks:     this.ticks,
    };
  }

  // ─── Node/edge manipulation ───────────────────────────────────────────────────

  syncPosition(id: number, x: number, y: number, vx = 0, vy = 0): void {
    const idx = this.nodeIndex.get(id);
    if (idx === undefined) return;
    this.posX[idx] = x; this.posY[idx] = y;
    this.velX[idx] = vx; this.velY[idx] = vy;
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
    this.reheat();
  }

  moveNode(id: number, x: number, y: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx !== undefined) { this.posX[idx] = x; this.posY[idx] = y; }
  }

  addNode(inputNode: { id: number; x?: number; y?: number }, connectedToIds?: number[]): void {
    let px = 0, py = 0, weight = 0;
    if (connectedToIds) {
      for (const nid of connectedToIds) {
        const ni = this.nodeIndex.get(nid);
        if (ni !== undefined) { px += this.posX[ni]; py += this.posY[ni]; weight++; }
      }
    }
    if (weight > 0) {
      px = px / weight + this.rng.range(-20, 20);
      py = py / weight + this.rng.range(-20, 20);
    } else if (this.n > 0) {
      let sx = 0, sy = 0;
      for (let i = 0; i < this.n; i++) { sx += this.posX[i]; sy += this.posY[i]; }
      px = sx / this.n + this.rng.range(-100, 100);
      py = sy / this.n + this.rng.range(-100, 100);
    }
    if (inputNode.x !== undefined && inputNode.x !== 0) px = inputNode.x;
    if (inputNode.y !== undefined && inputNode.y !== 0) py = inputNode.y;

    const idx = this.n;
    this.ensureCap(idx + 1);
    this.n++;

    this.nodeIdArr[idx] = inputNode.id;
    this.posX[idx] = px; this.posY[idx] = py;
    this.velX[idx] = 0;  this.velY[idx] = 0;
    this.oldAx[idx] = 0; this.oldAy[idx] = 0;
    this.pinnedArr[idx] = 0;
    this.degArr[idx]    = connectedToIds?.length ?? 0;
    this.iRadArr[idx]   = 0;

    let cid = 0, compid = 0;
    if (connectedToIds && connectedToIds.length > 0) {
      const ni = this.nodeIndex.get(connectedToIds[0]);
      if (ni !== undefined) { cid = this.clIdArr[ni]; compid = this.compIdArr[ni]; }
    }
    this.clIdArr[idx]   = cid;
    this.compIdArr[idx] = compid;

    this.nodeIndex.set(inputNode.id, idx);
    this.adjacency.set(inputNode.id, new Set());
    this._rebuildActiveIndices();
    this.reheat();
  }

  removeNode(id: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx === undefined) return;
    const last = this.n - 1;

    if (idx !== last) {
      this.posX[idx]      = this.posX[last];
      this.posY[idx]      = this.posY[last];
      this.velX[idx]      = this.velX[last];
      this.velY[idx]      = this.velY[last];
      this.oldAx[idx]     = this.oldAx[last];
      this.oldAy[idx]     = this.oldAy[last];
      this.pinnedArr[idx] = this.pinnedArr[last];
      this.clIdArr[idx]   = this.clIdArr[last];
      this.compIdArr[idx] = this.compIdArr[last];
      this.degArr[idx]    = this.degArr[last];
      this.iRadArr[idx]   = this.iRadArr[last];
      this.nodeIdArr[idx] = this.nodeIdArr[last];
      this.nodeIndex.set(this.nodeIdArr[idx], idx);
    }
    this.n--;
    this.nodeIndex.delete(id);

    const neighbors = this.adjacency.get(id);
    if (neighbors) {
      for (const nid of neighbors) {
        this.adjacency.get(nid)?.delete(id);
        const ni = this.nodeIndex.get(nid);
        if (ni !== undefined) this.degArr[ni] = this.adjacency.get(nid)?.size ?? 0;
      }
    }
    this.adjacency.delete(id);
    this.edges = this.edges.filter(e => e.source !== id && e.target !== id);
    this._rebuildEdgeArrays();
    this._rebuildActiveIndices();
    this.reheat();
  }

  addEdge(edge: SGEEdge): void {
    if (!this.adjacency.has(edge.source) || !this.adjacency.has(edge.target)) return;
    if (edge.source === edge.target) return;
    this.edges.push({ source: edge.source, target: edge.target });
    this.adjacency.get(edge.source)!.add(edge.target);
    this.adjacency.get(edge.target)!.add(edge.source);
    const si = this.nodeIndex.get(edge.source), ti = this.nodeIndex.get(edge.target);
    if (si !== undefined) this.degArr[si] = this.adjacency.get(edge.source)!.size;
    if (ti !== undefined) this.degArr[ti] = this.adjacency.get(edge.target)!.size;
    this._rebuildEdgeArrays();
    this.reheat();
  }

  setNodes(inputNodes: Array<{ id: number; x?: number; y?: number }>): void {
    const prev = new Map<number, { x: number; y: number; vx: number; vy: number }>();
    for (let i = 0; i < this.n; i++) {
      prev.set(this.nodeIdArr[i], { x: this.posX[i], y: this.posY[i], vx: this.velX[i], vy: this.velY[i] });
    }
    this.initializeGraph(inputNodes, this.edges);
    for (let i = 0; i < this.n; i++) {
      const p = prev.get(this.nodeIdArr[i]);
      if (p) { this.posX[i] = p.x; this.posY[i] = p.y; this.velX[i] = p.vx; this.velY[i] = p.vy; }
    }
    this.reheat();
  }

  setEdges(edges: SGEEdge[]): void {
    const prev = new Map<number, { x: number; y: number; vx: number; vy: number }>();
    for (let i = 0; i < this.n; i++) {
      prev.set(this.nodeIdArr[i], { x: this.posX[i], y: this.posY[i], vx: this.velX[i], vy: this.velY[i] });
    }
    const inputNodes = [];
    for (let i = 0; i < this.n; i++) inputNodes.push({ id: this.nodeIdArr[i], x: this.posX[i], y: this.posY[i] });
    this.initializeGraph(inputNodes, edges);
    for (let i = 0; i < this.n; i++) {
      const p = prev.get(this.nodeIdArr[i]);
      if (p) { this.posX[i] = p.x; this.posY[i] = p.y; this.velX[i] = p.vx; this.velY[i] = p.vy; }
    }
    this.reheat();
  }

  setConfig(partial: Partial<SGEConfig>): void {
    Object.assign(this.config, partial);
    if (partial.localRepelRadius !== undefined) this.spatialHash.setCellSize(partial.localRepelRadius);
    if (partial.seed !== undefined) this.rng = new SeededRNG(partial.seed);
    if (partial.idealDistance !== undefined) this._rebuildEdgeRest();
  }

  getNodePosition(id: number): { x: number; y: number } | undefined {
    const idx = this.nodeIndex.get(id);
    if (idx === undefined) return undefined;
    return { x: this.posX[idx], y: this.posY[idx] };
  }

  /** Returns true if the given node ID exists in the engine. */
  getNode(id: number): boolean {
    return this.nodeIndex.has(id);
  }

  /**
   * Inject an external force into the current step's force accumulator.
   * Must be called AFTER computeForces() and BEFORE integrate().
   */
  applyForce(id: number, fx: number, fy: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx === undefined || this.pinnedArr[idx]) return;
    this.axBuf[idx] += fx;
    this.ayBuf[idx] += fy;
  }

  // ─── Simulation control ───────────────────────────────────────────────────────

  reheat(): void {
    this.alpha  = Math.max(this.alpha, this.config.reheatFactor);
    this.frozen = false;
    this.prevDt = this.config.dt;
    this.oscillationCounter = 0;
  }

  freeze(): void { this.frozen = true; }

  start(): void {
    if (this.running) return;
    this.running = true; this.frozen = false;
    const tick = (): void => {
      if (!this.running) return;
      this.step();
      if (this.alpha < this.config.alphaMin && this.energy < 0.001) { this.running = false; return; }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
  }

  getAlpha():  number { return this.alpha; }
  getEnergy(): number { return this.energy; }

  get nodeCount(): number { return this.n; }
  get edgeCount(): number { return this.edges.length; }

  dispose(): void {
    this.stop();
    this.n = 0;
    this.edges = [];
    this.adjacency.clear();
    this.nodeIndex.clear();
  }
}


