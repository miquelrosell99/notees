/**
 * SemanticGraphEngine — Hybrid, stability-optimized, cluster-aware layout engine
 * for knowledge graphs. Replaces classical force-directed physics with a 3-layer
 * model: topological preprocessing, cluster-aware forces, and stabilized integration.
 *
 * Features:
 * - Deterministic layout via seeded PRNG
 * - Louvain-inspired community detection for cluster coherence
 * - Spatial hash grid for O(n) local repulsion (no global n²)
 * - Cluster-level repulsion (centroid-to-centroid)
 * - Velocity Verlet integration with adaptive timestep
 * - Energy-based convergence and auto-freeze
 * - Incremental node/edge updates without full reset
 *
 * Zero external dependencies. Renderer-agnostic.
 */

// ============================================================
// Types
// ============================================================

export interface SGENode {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  fx: number;
  fy: number;
  pinned: boolean;
  componentId: number;
  clusterId: number;
  degree: number;
  centrality: number;
  initialRadius: number;
  initialAngle: number;
}

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
}

export interface SGEState {
  nodes: ReadonlyArray<Readonly<SGENode>>;
  alpha: number;
  energy: number;
  running: boolean;
  ticks: number;
}

// ============================================================
// Deterministic PRNG (xoshiro128**)
// ============================================================

class SeededRNG {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // SplitMix32 seeding
    let s = seed | 0;
    const sm = (): number => {
      s = (s + 0x9e3779b9) | 0;
      let t = s ^ (s >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      return t >>> 0;
    };
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
  }

  /** Returns a float in [0, 1) */
  next(): number {
    const result = Math.imul(this.s1 * 5, 7) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = (this.s3 << 11) | (this.s3 >>> 21);
    return (result >>> 0) / 4294967296;
  }

  /** Returns a float in [min, max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

// ============================================================
// Spatial Hash Grid
// ============================================================

class SpatialHashGrid {
  private invCellSize: number;
  private cells: Map<number, number[]>;
  private reusableBuckets: number[][];
  private reusableIdx: number;

  // Pre-allocated result buffer for zero-alloc neighbour queries
  resultBuf: Int32Array = new Int32Array(512);

  constructor(cellSize: number) {
    this.invCellSize = 1 / cellSize;
    this.cells = new Map();
    this.reusableBuckets = [];
    this.reusableIdx = 0;
  }

  clear(): void {
    // Reclaim buckets for reuse instead of allocating new arrays
    for (const bucket of this.cells.values()) {
      bucket.length = 0;
      if (this.reusableIdx < this.reusableBuckets.length) {
        this.reusableBuckets[this.reusableIdx++] = bucket;
      } else {
        this.reusableBuckets.push(bucket);
        this.reusableIdx++;
      }
    }
    this.cells.clear();
    this.reusableIdx = 0;
  }

  setCellSize(size: number): void {
    this.invCellSize = 1 / size;
  }

  private key(cx: number, cy: number): number {
    // Large primes for hashing grid coordinates
    return ((cx * 73856093) ^ (cy * 19349663)) | 0;
  }

  private getBucket(cx: number, cy: number): number[] {
    const k = this.key(cx, cy);
    let bucket = this.cells.get(k);
    if (!bucket) {
      if (this.reusableIdx > 0) {
        bucket = this.reusableBuckets[--this.reusableIdx];
      } else {
        bucket = [];
      }
      this.cells.set(k, bucket);
    }
    return bucket;
  }

  insert(index: number, x: number, y: number): void {
    const cx = Math.floor(x * this.invCellSize);
    const cy = Math.floor(y * this.invCellSize);
    this.getBucket(cx, cy).push(index);
  }

  /**
   * Query neighbours into the pre-allocated resultBuf.
   * Returns the count of results.  Caller reads resultBuf[0..count-1].
   * Zero per-call allocation, no closure overhead.
   */
  queryInto(x: number, y: number): number {
    let count = 0;
    const cx = Math.floor(x * this.invCellSize);
    const cy = Math.floor(y * this.invCellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k = this.key(cx + dx, cy + dy);
        const bucket = this.cells.get(k);
        if (bucket) {
          const blen = bucket.length;
          // Grow buffer if needed (rare — only on first few frames)
          if (count + blen > this.resultBuf.length) {
            const newBuf = new Int32Array(Math.max(this.resultBuf.length * 2, count + blen + 64));
            newBuf.set(this.resultBuf.subarray(0, count));
            this.resultBuf = newBuf;
          }
          for (let bi = 0; bi < blen; bi++) {
            this.resultBuf[count++] = bucket[bi];
          }
        }
      }
    }
    return count;
  }
}

// ============================================================
// Community Detection (Louvain-inspired modularity optimization)
// ============================================================

function detectCommunities(
  nodeCount: number,
  nodeIds: number[],
  adjacency: Map<number, Set<number>>,
  edgeCount: number,
  rng: SeededRNG,
  /** Warm-start: previous community assignment. Nodes present here start in
   *  their old community instead of singleton, letting Louvain converge faster. */
  priorCommunities?: Map<number, number>,
): Map<number, number> {
  const community = new Map<number, number>();
  const idToIdx = new Map<number, number>();
  for (let i = 0; i < nodeIds.length; i++) {
    community.set(nodeIds[i], i);
    idToIdx.set(nodeIds[i], i);
  }

  if (edgeCount === 0) return community;

  const m2 = edgeCount * 2; // 2 * total edges
  
  // Degree of each node
  const deg = new Float64Array(nodeCount);
  for (let i = 0; i < nodeIds.length; i++) {
    deg[i] = adjacency.get(nodeIds[i])?.size ?? 0;
  }

  // Node -> community mapping (indexed)
  const nodeCommunity = new Int32Array(nodeCount);

  // Warm-start: seed from prior communities if available
  if (priorCommunities && priorCommunities.size > 0) {
    // Remap prior community IDs to local indices: collect unique prior IDs
    // and assign contiguous IDs starting from 0.
    const priorIdRemap = new Map<number, number>();
    let nextPriorId = 0;
    for (let i = 0; i < nodeCount; i++) {
      const priorComm = priorCommunities.get(nodeIds[i]);
      if (priorComm !== undefined) {
        if (!priorIdRemap.has(priorComm)) {
          priorIdRemap.set(priorComm, nextPriorId++);
        }
        nodeCommunity[i] = priorIdRemap.get(priorComm)!;
      } else {
        // New node: assign to singleton (unique index beyond existing communities)
        nodeCommunity[i] = nextPriorId++;
      }
    }
  } else {
    for (let i = 0; i < nodeCount; i++) {
      nodeCommunity[i] = i;
    }
  }

  // Community -> sum of degrees
  const communityDegSum = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    communityDegSum[nodeCommunity[i]] += deg[i];
  }

  // Community -> internal edges * 2
  const communityInternalEdges = new Float64Array(nodeCount);

  // Scale max passes: large graphs converge with fewer passes;
  // warm-started graphs converge even faster.
  const hasWarmStart = priorCommunities && priorCommunities.size > 0;
  const basePasses = hasWarmStart ? 6 : 20;
  const maxPasses = nodeCount > 2000
    ? Math.max(3, Math.min(basePasses, Math.ceil(8000 / nodeCount)))
    : basePasses;
  const shuffled = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) shuffled[i] = i;

  // Fisher-Yates shuffle with seeded RNG for determinism
  const shuffle = (): void => {
    for (let i = nodeCount - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
  };

  // Temporary storage for neighbor community edge counts
  const neighborComm = new Map<number, number>();

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    let totalGain = 0;
    shuffle();

    for (let si = 0; si < nodeCount; si++) {
      const i = shuffled[si];
      const nodeId = nodeIds[i];
      const neighbors = adjacency.get(nodeId);
      if (!neighbors || neighbors.size === 0) continue;

      const currentComm = nodeCommunity[i];
      const ki = deg[i];

      // Count edges to each neighboring community
      neighborComm.clear();
      let edgesToCurrentComm = 0;
      for (const neighborId of neighbors) {
        const nIdx = idToIdx.get(neighborId);
        if (nIdx === undefined) continue;
        const nComm = nodeCommunity[nIdx];
        neighborComm.set(nComm, (neighborComm.get(nComm) ?? 0) + 1);
        if (nComm === currentComm) edgesToCurrentComm++;
      }

      // Modularity gain of removing node from current community
      const sigmaCurrentWithout = communityDegSum[currentComm] - ki;
      const removeLoss = edgesToCurrentComm / m2 - (ki * sigmaCurrentWithout) / (m2 * m2);

      // Find best community to move to
      let bestComm = currentComm;
      let bestGain = 0;

      for (const [candidateComm, edgesToCandidate] of neighborComm) {
        if (candidateComm === currentComm) continue;
        const sigmaCandidateTotal = communityDegSum[candidateComm];
        const moveGain = edgesToCandidate / m2 - (ki * sigmaCandidateTotal) / (m2 * m2);
        const netGain = moveGain - removeLoss;
        if (netGain > bestGain) {
          bestGain = netGain;
          bestComm = candidateComm;
        }
      }

      if (bestComm !== currentComm && bestGain > 1e-10) {
        // Move node to best community
        communityDegSum[currentComm] -= ki;
        communityInternalEdges[currentComm] -= edgesToCurrentComm * 2;
        
        nodeCommunity[i] = bestComm;
        communityDegSum[bestComm] += ki;
        const edgesToBest = neighborComm.get(bestComm) ?? 0;
        communityInternalEdges[bestComm] += edgesToBest * 2;
        
        improved = true;
        totalGain += bestGain;
      }
    }

    if (!improved) break;
    // Early exit: if total modularity gain this pass is negligible, stop
    if (totalGain < 1e-6) break;
  }

  // Compact community IDs to 0..K-1
  const uniqueComms = new Set<number>();
  for (let i = 0; i < nodeCount; i++) {
    uniqueComms.add(nodeCommunity[i]);
  }
  const commRemap = new Map<number, number>();
  let nextId = 0;
  for (const c of uniqueComms) {
    commRemap.set(c, nextId++);
  }

  const result = new Map<number, number>();
  for (let i = 0; i < nodeCount; i++) {
    result.set(nodeIds[i], commRemap.get(nodeCommunity[i])!);
  }
  return result;
}

// ============================================================
// Connected Components (BFS)
// ============================================================

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
    queue.length = 0;
    queue.push(startId);
    visited.add(startId);

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      component.set(nodeId, componentId);
      const neighbors = adjacency.get(nodeId);
      if (neighbors) {
        for (const nId of neighbors) {
          if (!visited.has(nId)) {
            visited.add(nId);
            queue.push(nId);
          }
        }
      }
    }
    componentId++;
  }
  return component;
}

// ============================================================
// Default Configuration
// ============================================================

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
  alphaDecay: 0.005,
  alphaMin: 0.001,
  reheatFactor: 0.3,

  dt: 1.0,
};

// ============================================================
// SemanticGraphEngine
// ============================================================

export class SemanticGraphEngine {
  private nodes: SGENode[];
  private edges: SGEEdge[];
  private config: SGEConfig;
  private rng: SeededRNG;

  // Topology
  private adjacency: Map<number, Set<number>>;
  private nodeIndex: Map<number, number>; // id -> array index
  private componentMap: Map<number, number>;
  private clusterMap: Map<number, number>;

  // Cluster management — flat indexed arrays (clusterId is 0..K-1)
  // Replaces Map<clusterId, ClusterData> to eliminate per-step Map overhead.
  private clCx: Float64Array = new Float64Array(0);   // centroid X
  private clCy: Float64Array = new Float64Array(0);   // centroid Y
  private clCount: Int32Array = new Int32Array(0);     // node count per cluster
  private clFx: Float64Array = new Float64Array(0);    // force accumulator X
  private clFy: Float64Array = new Float64Array(0);    // force accumulator Y
  // Only clusters with count > 1 go into pairwise repulsion (Section B).
  // Singleton clusters (orphan pages) are handled by local repulsion (Section D).
  private bigClusterBuf: Int32Array = new Int32Array(0);
  private bigClusterCount = 0;

  // Component centers — flat indexed arrays (componentId is 0..C-1)
  private ccX: Float64Array = new Float64Array(0);
  private ccY: Float64Array = new Float64Array(0);
  private ccCount: Int32Array = new Int32Array(0);

  // Spatial hash
  private spatialGrid: SpatialHashGrid;

  // Simulation state
  private alpha: number;
  private energy: number;
  private running: boolean;
  private frozen: boolean;
  private ticks: number;
  private rafId: number;
  private prevDt: number;
  private oscillationCounter: number;
  private prevEnergy: number;

  // Pre-allocated acceleration buffer
  private axBuf: Float64Array;
  private ayBuf: Float64Array;

  constructor(
    inputNodes: Array<{ id: number; x?: number; y?: number }>,
    inputEdges: SGEEdge[],
    config?: Partial<SGEConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rng = new SeededRNG(this.config.seed);
    this.nodes = [];
    this.edges = [];
    this.adjacency = new Map();
    this.nodeIndex = new Map();
    this.componentMap = new Map();
    this.clusterMap = new Map();
    this.spatialGrid = new SpatialHashGrid(this.config.localRepelRadius);
    this.alpha = this.config.alpha;
    this.energy = Infinity;
    this.running = false;
    this.frozen = false;
    this.ticks = 0;
    this.rafId = 0;
    this.prevDt = this.config.dt;
    this.oscillationCounter = 0;
    this.prevEnergy = Infinity;
    this.axBuf = new Float64Array(0);
    this.ayBuf = new Float64Array(0);

    this.initializeGraph(inputNodes, inputEdges);
  }

  // ============================================================
  // Initialization
  // ============================================================

  private initializeGraph(
    inputNodes: Array<{ id: number; x?: number; y?: number }>,
    inputEdges: SGEEdge[],
  ): void {
    // Build adjacency
    const nodeIdSet = new Set(inputNodes.map(n => n.id));
    this.adjacency.clear();
    for (const n of inputNodes) {
      this.adjacency.set(n.id, new Set());
    }
    
    // Filter edges to only include valid node pairs
    this.edges = [];
    let edgeCount = 0;
    for (const e of inputEdges) {
      if (nodeIdSet.has(e.source) && nodeIdSet.has(e.target) && e.source !== e.target) {
        this.edges.push({ source: e.source, target: e.target });
        this.adjacency.get(e.source)!.add(e.target);
        this.adjacency.get(e.target)!.add(e.source);
        edgeCount++;
      }
    }

    const nodeIds = inputNodes.map(n => n.id);

    // LAYER 1: Topological preprocessing
    this.componentMap = findConnectedComponents(nodeIds, this.adjacency);
    // Warm-start: pass previous cluster assignments so Louvain converges faster
    // when topology changed only slightly (common for incremental updates).
    const priorClusters = this.clusterMap.size > 0 ? this.clusterMap : undefined;
    this.clusterMap = detectCommunities(
      inputNodes.length,
      nodeIds,
      this.adjacency,
      edgeCount,
      this.rng,
      priorClusters,
    );

    // Create SGENode objects
    this.nodes = [];
    this.nodeIndex.clear();
    for (let i = 0; i < inputNodes.length; i++) {
      const inp = inputNodes[i];
      const degree = this.adjacency.get(inp.id)?.size ?? 0;
      const node: SGENode = {
        id: inp.id,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        ax: 0,
        ay: 0,
        fx: 0,
        fy: 0,
        pinned: false,
        componentId: this.componentMap.get(inp.id) ?? 0,
        clusterId: this.clusterMap.get(inp.id) ?? 0,
        degree,
        centrality: degree, // degree centrality approximation
        initialRadius: 0,
        initialAngle: 0,
      };
      this.nodes.push(node);
      this.nodeIndex.set(inp.id, i);
    }

    // Deterministic initial positioning
    this.computeInitialPositions(inputNodes);

    // Override with user-provided positions if available
    for (let i = 0; i < inputNodes.length; i++) {
      const inp = inputNodes[i];
      if (inp.x !== undefined && inp.x !== 0) this.nodes[i].x = inp.x;
      if (inp.y !== undefined && inp.y !== 0) this.nodes[i].y = inp.y;
    }

    // Allocate acceleration buffers
    this.ensureBuffers(this.nodes.length);

    // Build initial cluster data
    this.updateClusterData();
  }

  private ensureBuffers(count: number): void {
    if (this.axBuf.length < count) {
      this.axBuf = new Float64Array(Math.max(count, 256));
      this.ayBuf = new Float64Array(Math.max(count, 256));
    }
  }

  private computeInitialPositions(
    _inputNodes: Array<{ id: number; x?: number; y?: number }>,
  ): void {
    const cfg = this.config;
    const rng = this.rng;

    // Group nodes by component
    const componentGroups = new Map<number, number[]>();
    for (let i = 0; i < this.nodes.length; i++) {
      const cId = this.nodes[i].componentId;
      let group = componentGroups.get(cId);
      if (!group) {
        group = [];
        componentGroups.set(cId, group);
      }
      group.push(i);
    }

    // Place components radially
    const componentIds = [...componentGroups.keys()].sort((a, b) => {
      return (componentGroups.get(b)?.length ?? 0) - (componentGroups.get(a)?.length ?? 0);
    });

    let componentAngle = 0;
    const componentSpacing = cfg.componentSpacing;
    const clusterSpacing = cfg.clusterSpacing;
    const totalComponents = componentIds.length;

    for (let ci = 0; ci < totalComponents; ci++) {
      const cId = componentIds[ci];
      const nodeIndices = componentGroups.get(cId)!;

      // Component center — first and largest component at origin
      let compCenterX = 0;
      let compCenterY = 0;
      if (ci > 0) {
        const radius = componentSpacing * Math.sqrt(ci);
        compCenterX = radius * Math.cos(componentAngle);
        compCenterY = radius * Math.sin(componentAngle);
        componentAngle += 2.399963; // golden angle
      }

      // Group nodes within component by cluster
      const clusterGroups = new Map<number, number[]>();
      for (const idx of nodeIndices) {
        const clustId = this.nodes[idx].clusterId;
        let cGroup = clusterGroups.get(clustId);
        if (!cGroup) {
          cGroup = [];
          clusterGroups.set(clustId, cGroup);
        }
        cGroup.push(idx);
      }

      // Place clusters in circular shells around component center
      const clusterIdsSorted = [...clusterGroups.keys()].sort((a, b) => {
        return (clusterGroups.get(b)?.length ?? 0) - (clusterGroups.get(a)?.length ?? 0);
      });

      let clusterAngle = rng.next() * Math.PI * 2;

      for (let ki = 0; ki < clusterIdsSorted.length; ki++) {
        const kId = clusterIdsSorted[ki];
        const members = clusterGroups.get(kId)!;

        // Cluster center
        let clusterCenterX = compCenterX;
        let clusterCenterY = compCenterY;
        if (ki > 0) {
          const clusterRadius = clusterSpacing * Math.sqrt(ki);
          clusterCenterX = compCenterX + clusterRadius * Math.cos(clusterAngle);
          clusterCenterY = compCenterY + clusterRadius * Math.sin(clusterAngle);
          clusterAngle += 2.399963; // golden angle
        }

        // Distribute nodes within cluster using golden-angle spiral
        const goldenAngle = 2.399963229728653; // π(3−√5)
        let spiralAngle = rng.next() * Math.PI * 2;
        for (let ni = 0; ni < members.length; ni++) {
          const idx = members[ni];
          const r = cfg.idealDistance * 0.5 * Math.sqrt(ni + 1);
          const angle = spiralAngle + ni * goldenAngle;

          this.nodes[idx].x = clusterCenterX + r * Math.cos(angle);
          this.nodes[idx].y = clusterCenterY + r * Math.sin(angle);
          this.nodes[idx].initialRadius = r;
          this.nodes[idx].initialAngle = angle;
        }
      }
    }
  }

  // ============================================================
  // Cluster Data Management
  // ============================================================

  /** Ensure cluster/component index arrays are large enough. */
  private ensureClusterBuffers(k: number): void {
    if (this.clCx.length >= k) return;
    const cap = Math.max(k, 256);
    this.clCx    = new Float64Array(cap);
    this.clCy    = new Float64Array(cap);
    this.clCount = new Int32Array(cap);
    this.clFx    = new Float64Array(cap);
    this.clFy    = new Float64Array(cap);
    this.bigClusterBuf = new Int32Array(cap);
  }

  private ensureComponentBuffers(c: number): void {
    if (this.ccX.length >= c) return;
    const cap = Math.max(c, 64);
    this.ccX     = new Float64Array(cap);
    this.ccY     = new Float64Array(cap);
    this.ccCount = new Int32Array(cap);
  }

  private updateClusterData(): void {
    const nodes = this.nodes;
    const n = nodes.length;

    // Find max cluster ID to size arrays
    let maxClId = 0;
    for (let i = 0; i < n; i++) {
      if (nodes[i].clusterId > maxClId) maxClId = nodes[i].clusterId;
    }
    const K = maxClId + 1;
    this.ensureClusterBuffers(K);

    const cx = this.clCx;
    const cy = this.clCy;
    const cc = this.clCount;
    for (let i = 0; i < K; i++) { cx[i] = 0; cy[i] = 0; cc[i] = 0; }

    for (let i = 0; i < n; i++) {
      const c = nodes[i].clusterId;
      cx[c] += nodes[i].x;
      cy[c] += nodes[i].y;
      cc[c]++;
    }

    // Finalise centroids and collect non-singleton cluster IDs for Section B
    let bigCount = 0;
    for (let i = 0; i < K; i++) {
      if (cc[i] > 0) {
        cx[i] /= cc[i];
        cy[i] /= cc[i];
        if (cc[i] > 1) {
          this.bigClusterBuf[bigCount++] = i;
        }
      }
    }
    this.bigClusterCount = bigCount;
  }

  // ============================================================
  // LAYER 2: Force Computation
  // ============================================================

  /** Phase 1: Compute all engine forces. Call integrate() after injecting any external forces. */
  computeForces(): void {
    const nodes = this.nodes;
    const n = nodes.length;
    const cfg = this.config;
    const alpha = this.alpha;

    // Zero acceleration buffers
    const ax = this.axBuf;
    const ay = this.ayBuf;
    for (let i = 0; i < n; i++) {
      ax[i] = 0;
      ay[i] = 0;
    }

    // Update cluster centroids
    this.updateClusterData();

    // A) Intra-Cluster Cohesion (shell model)
    const clusterStr = cfg.clusterStrength * alpha;
    const clCx = this.clCx;
    const clCy = this.clCy;
    const clCC = this.clCount;
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      if (node.pinned) continue;
      const cid = node.clusterId;
      const cnt = clCC[cid];
      if (cnt <= 1) continue;
      const dx = node.x - clCx[cid];
      const dy = node.y - clCy[cid];
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const shellRadius = cfg.idealDistance * 0.5 * Math.sqrt(cnt);
      const radiusError = dist - shellRadius;
      const strength = radiusError > 0
        ? -clusterStr * radiusError
        : -clusterStr * radiusError * 0.15;
      ax[i] += (dx / dist) * strength;
      ay[i] += (dy / dist) * strength;
    }

    // B) Inter-Cluster Repulsion (centroid-to-centroid, mass-scaled, √n-adjusted)
    // Only non-singleton clusters participate — orphan pages are spaced by
    // local repulsion (Section D).  This reduces O(K²) dramatically when
    // many pages have no links (each is its own cluster).
    const nScale = n > 1 ? Math.sqrt(n) : 1;
    const clusterRepelStr = cfg.clusterRepelStrength * alpha * nScale;
    const bigIds  = this.bigClusterBuf;
    const bigK    = this.bigClusterCount;
    const clFx    = this.clFx;
    const clFy    = this.clFy;
    // Zero force accumulators for participating clusters only
    for (let i = 0; i < bigK; i++) { const c = bigIds[i]; clFx[c] = 0; clFy[c] = 0; }

    for (let a = 0; a < bigK; a++) {
      const ai = bigIds[a];
      const caCx = clCx[ai], caCy = clCy[ai], caCnt = clCC[ai];
      for (let b = a + 1; b < bigK; b++) {
        const bi = bigIds[b];
        const dx = caCx - clCx[bi];
        const dy = caCy - clCy[bi];
        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq) || 1;
        const massFactor = Math.sqrt(caCnt * clCC[bi]);
        const force = clusterRepelStr * massFactor / (distSq || 1);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        clFx[ai] += fx;  clFy[ai] += fy;
        clFx[bi] -= fx;  clFy[bi] -= fy;
      }
    }

    // Distribute cluster repulsion to member nodes
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      if (node.pinned) continue;
      const cid = node.clusterId;
      const cnt = clCC[cid];
      if (cnt <= 1) continue; // singleton → no cluster repulsion
      ax[i] += clFx[cid] / cnt;
      ay[i] += clFy[cid] / cnt;
    }

    // C) Local Edge Springs (Hooke's law with degree scaling)
    const springStr = cfg.springStrength * alpha;
    const idealDist = cfg.idealDistance;
    for (const edge of this.edges) {
      const si = this.nodeIndex.get(edge.source);
      const ti = this.nodeIndex.get(edge.target);
      if (si === undefined || ti === undefined) continue;
      const ns = nodes[si];
      const nt = nodes[ti];
      const dx = nt.x - ns.x;
      const dy = nt.y - ns.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const displacement = dist - idealDist;

      // Spring strength scales by 1/sqrt(max(degree_s, degree_t))
      const maxDeg = Math.max(ns.degree, nt.degree, 1);
      const degScale = 1 / Math.sqrt(maxDeg);
      const force = springStr * displacement * degScale;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (!ns.pinned) {
        ax[si] += fx;
        ay[si] += fy;
      }
      if (!nt.pinned) {
        ax[ti] -= fx;
        ay[ti] -= fy;
      }
    }

    // D) Node Repulsion with smooth falloff (spatial hash grid, no hard boundary)
    // Uses 1/d² core with quintic smoothing near the cutoff radius,
    // so force tapers to zero continuously (no stiff wall).
    //
    // Adaptive radius: for large graphs (>1000 nodes) we scale down the
    // repel radius so each query touches fewer neighbours.  The inter-cluster
    // repulsion (Section B) handles macro-level spacing, so cutting the
    // local radius only affects close-range smoothing.
    const baseRepelRadius = cfg.localRepelRadius;
    const repelRadius = n > 1000
      ? baseRepelRadius * Math.min(1, Math.sqrt(1000 / n))
      : baseRepelRadius;
    const repelStr = cfg.localRepelStrength * alpha;
    const repelRadiusSq = repelRadius * repelRadius;
    const invRepelRadius = 1 / repelRadius;

    this.spatialGrid.setCellSize(repelRadius);
    this.spatialGrid.clear();
    for (let i = 0; i < n; i++) {
      this.spatialGrid.insert(i, nodes[i].x, nodes[i].y);
    }

    // Buffer-based query: zero closures, zero per-call allocation.
    const grid = this.spatialGrid;
    for (let i = 0; i < n; i++) {
      const ni = nodes[i];
      if (ni.pinned) continue;
      const nix = ni.x;
      const niy = ni.y;
      const nCount = grid.queryInto(nix, niy);
      const nbuf = grid.resultBuf;
      for (let k = 0; k < nCount; k++) {
        const j = nbuf[k];
        if (j <= i) continue; // avoid double-counting
        const nj = nodes[j];
        const dx = nix - nj.x;
        const dy = niy - nj.y;
        const distSq = dx * dx + dy * dy;
        if (distSq >= repelRadiusSq || distSq < 0.01) continue;
        const dist = Math.sqrt(distSq);
        // Smooth quintic envelope: t goes 1→0 as dist goes 0→repelRadius
        // smoothstep(t) = t³(6t²−15t+10) — C² continuous at boundary
        const t = 1 - dist * invRepelRadius;
        const envelope = t * t * t * (t * (t * 6 - 15) + 10);
        const force = repelStr * envelope / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        ax[i] += fx;
        ay[i] += fy;
        if (!nj.pinned) {
          ax[j] -= fx;
          ay[j] -= fy;
        }
      }
    }

    // E) Radial Stability Constraint
    const radialStr = cfg.radialStrength * alpha;
    if (radialStr > 0) {
      for (let i = 0; i < n; i++) {
        const node = nodes[i];
        if (node.pinned) continue;
        const cid = node.clusterId;
        if (clCC[cid] === 0) continue;
        const dx = node.x - clCx[cid];
        const dy = node.y - clCy[cid];
        const currentRadius = Math.sqrt(dx * dx + dy * dy) || 1;
        const radiusDiff = currentRadius - node.initialRadius;
        const radialForce = -radialStr * radiusDiff;
        ax[i] += (dx / currentRadius) * radialForce;
        ay[i] += (dy / currentRadius) * radialForce;
      }
    }

    // F) Center Gravity (per connected component, very weak)
    const centerStr = cfg.componentCenterStrength * alpha;
    if (centerStr > 0) {
      // Compute component centers using flat indexed arrays
      let maxCompId = 0;
      for (let i = 0; i < n; i++) {
        if (nodes[i].componentId > maxCompId) maxCompId = nodes[i].componentId;
      }
      const C = maxCompId + 1;
      this.ensureComponentBuffers(C);
      const compX = this.ccX;
      const compY = this.ccY;
      const compC = this.ccCount;
      for (let i = 0; i < C; i++) { compX[i] = 0; compY[i] = 0; compC[i] = 0; }

      for (let i = 0; i < n; i++) {
        const cid = nodes[i].componentId;
        compX[cid] += nodes[i].x;
        compY[cid] += nodes[i].y;
        compC[cid]++;
      }
      for (let i = 0; i < C; i++) {
        if (compC[i] > 0) { compX[i] /= compC[i]; compY[i] /= compC[i]; }
      }

      for (let i = 0; i < n; i++) {
        const node = nodes[i];
        if (node.pinned) continue;
        const cid = node.componentId;
        ax[i] -= centerStr * (node.x - compX[cid]);
        ay[i] -= centerStr * (node.y - compY[cid]);
      }
    }

    // Store forces in nodes
    for (let i = 0; i < n; i++) {
      nodes[i].fx = ax[i];
      nodes[i].fy = ay[i];
    }
  }

  // ============================================================
  // LAYER 3: Stabilized Integrator (Velocity Verlet)
  // ============================================================

  /** Phase 2: Verlet integration + alpha cooling. Call after computeForces() + any applyForce() calls. */
  integrate(): void {
    const nodes = this.nodes;
    const n = nodes.length;
    const cfg = this.config;
    const dt = this.prevDt;
    const halfDtSq = 0.5 * dt * dt;
    const maxVel = cfg.maxVelocity;
    const maxVelSq = maxVel * maxVel;
    const damping = cfg.damping;

    let totalEnergy = 0;

    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      if (node.pinned) continue;

      // Velocity Verlet: x += vx * dt + 0.5 * ax_old * dt^2
      node.x += node.vx * dt + node.ax * halfDtSq;
      node.y += node.vy * dt + node.ay * halfDtSq;

      // Update velocity: vx += 0.5 * (ax_old + ax_new) * dt
      const newAx = node.fx;
      const newAy = node.fy;
      node.vx += 0.5 * (node.ax + newAx) * dt;
      node.vy += 0.5 * (node.ay + newAy) * dt;

      // Apply damping
      node.vx *= damping;
      node.vy *= damping;

      // Hard velocity cap
      const velSq = node.vx * node.vx + node.vy * node.vy;
      if (velSq > maxVelSq) {
        const scale = maxVel / Math.sqrt(velSq);
        node.vx *= scale;
        node.vy *= scale;
      }

      // Store new acceleration for next step
      node.ax = newAx;
      node.ay = newAy;

      totalEnergy += node.vx * node.vx + node.vy * node.vy;
    }

    this.energy = n > 0 ? totalEnergy / n : 0;

    // Adaptive timestep: reduce if oscillation detected
    if (this.energy > this.prevEnergy * 1.1 && this.energy > 0.01) {
      this.oscillationCounter++;
      if (this.oscillationCounter > 3) {
        this.prevDt = Math.max(cfg.dt * 0.25, this.prevDt * 0.8);
        this.oscillationCounter = 0;
      }
    } else {
      this.oscillationCounter = 0;
      // Slowly restore dt
      if (this.prevDt < cfg.dt) {
        this.prevDt = Math.min(cfg.dt, this.prevDt * 1.02);
      }
    }

    this.prevEnergy = this.energy;

    // Alpha cooling
    this.alpha += (0 - this.alpha) * cfg.alphaDecay;

    this.ticks++;
  }

  // ============================================================
  // Public API
  // ============================================================

  /** Run a single tick of the simulation (computeForces + integrate). */
  step(): void {
    if (this.frozen) return;
    this.computeForces();
    this.integrate();
  }

  /**
   * Inject an external force on a node. Call between computeForces() and integrate().
   * Forces accumulate additively with the engine's own forces.
   */
  applyForce(id: number, fx: number, fy: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx === undefined) return;
    this.nodes[idx].fx += fx;
    this.nodes[idx].fy += fy;
  }

  /**
   * Sync a node's position (and optionally velocity) into the engine
   * after external constraint projection.
   */
  syncPosition(id: number, x: number, y: number, vx?: number, vy?: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx !== undefined) {
      this.nodes[idx].x = x;
      this.nodes[idx].y = y;
      if (vx !== undefined) this.nodes[idx].vx = vx;
      if (vy !== undefined) this.nodes[idx].vy = vy;
    }
  }

  /** Get the current alpha value */
  getAlpha(): number {
    return this.alpha;
  }

  /** Get the current average kinetic energy */
  getEnergy(): number {
    return this.energy;
  }

  /** Start the simulation loop (requestAnimationFrame) */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.frozen = false;
    const tick = (): void => {
      if (!this.running) return;
      this.step();
      if (this.alpha < this.config.alphaMin && this.energy < 0.001) {
        this.running = false;
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Stop the simulation loop */
  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** Reheat the simulation (e.g., after node release) */
  reheat(): void {
    this.alpha = Math.max(this.alpha, this.config.reheatFactor);
    this.frozen = false;
    this.prevDt = this.config.dt;
    this.oscillationCounter = 0;
  }

  /** Freeze the simulation — no more ticks until reheated */
  freeze(): void {
    this.frozen = true;
  }

  /** Replace the full node set */
  setNodes(inputNodes: Array<{ id: number; x?: number; y?: number }>): void {
    const preservedPositions = new Map<number, { x: number; y: number; vx: number; vy: number }>();
    for (const node of this.nodes) {
      preservedPositions.set(node.id, { x: node.x, y: node.y, vx: node.vx, vy: node.vy });
    }

    this.initializeGraph(inputNodes, this.edges);

    // Restore positions for nodes that existed before
    for (const node of this.nodes) {
      const prev = preservedPositions.get(node.id);
      if (prev) {
        node.x = prev.x;
        node.y = prev.y;
        node.vx = prev.vx;
        node.vy = prev.vy;
      }
    }

    this.reheat();
  }

  /** Replace the full edge set */
  setEdges(edges: SGEEdge[]): void {
    const preservedPositions = new Map<number, { x: number; y: number; vx: number; vy: number }>();
    for (const node of this.nodes) {
      preservedPositions.set(node.id, { x: node.x, y: node.y, vx: node.vx, vy: node.vy });
    }

    const inputNodes = this.nodes.map(n => ({ id: n.id, x: n.x, y: n.y }));
    this.initializeGraph(inputNodes, edges);

    for (const node of this.nodes) {
      const prev = preservedPositions.get(node.id);
      if (prev) {
        node.x = prev.x;
        node.y = prev.y;
        node.vx = prev.vx;
        node.vy = prev.vy;
      }
    }

    this.reheat();
  }

  /** Update config partially */
  setConfig(partial: Partial<SGEConfig>): void {
    Object.assign(this.config, partial);
    if (partial.localRepelRadius !== undefined) {
      this.spatialGrid.setCellSize(partial.localRepelRadius);
    }
    if (partial.seed !== undefined) {
      this.rng = new SeededRNG(partial.seed);
    }
  }

  /** Get current simulation state (readonly snapshot) */
  getState(): SGEState {
    return {
      nodes: this.nodes,
      alpha: this.alpha,
      energy: this.energy,
      running: this.running,
      ticks: this.ticks,
    };
  }

  /** Get a node by ID */
  getNode(id: number): SGENode | undefined {
    const idx = this.nodeIndex.get(id);
    return idx !== undefined ? this.nodes[idx] : undefined;
  }

  /** Pin a node at its current position (for dragging) */
  pinNode(id: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx !== undefined) {
      this.nodes[idx].pinned = true;
    }
  }

  /** Set pinned node position directly (for drag tracking) */
  moveNode(id: number, x: number, y: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx !== undefined) {
      this.nodes[idx].x = x;
      this.nodes[idx].y = y;
    }
  }

  /** Unpin a node and reheat (for drag release) */
  unpinNode(id: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx !== undefined) {
      this.nodes[idx].pinned = false;
      this.nodes[idx].vx = 0;
      this.nodes[idx].vy = 0;
    }
    this.reheat();
  }

  /** Add a node incrementally — placed near its neighbors (weighted barycentric) */
  addNode(inputNode: { id: number; x?: number; y?: number }, connectedToIds?: number[]): void {
    // Compute initial position by weighted barycentric placement near neighbors
    let px = 0;
    let py = 0;
    let weight = 0;

    if (connectedToIds && connectedToIds.length > 0) {
      for (const nid of connectedToIds) {
        const nIdx = this.nodeIndex.get(nid);
        if (nIdx !== undefined) {
          const neighbor = this.nodes[nIdx];
          px += neighbor.x;
          py += neighbor.y;
          weight++;
        }
      }
    }

    if (weight > 0) {
      px /= weight;
      py /= weight;
      // Add small random offset to prevent exact overlap
      px += this.rng.range(-20, 20);
      py += this.rng.range(-20, 20);
    } else {
      // No neighbors — place near graph center with jitter
      let cx = 0, cy = 0, cnt = 0;
      for (const node of this.nodes) {
        cx += node.x;
        cy += node.y;
        cnt++;
      }
      if (cnt > 0) {
        px = cx / cnt + this.rng.range(-100, 100);
        py = cy / cnt + this.rng.range(-100, 100);
      }
    }

    if (inputNode.x !== undefined && inputNode.x !== 0) px = inputNode.x;
    if (inputNode.y !== undefined && inputNode.y !== 0) py = inputNode.y;

    const degree = connectedToIds?.length ?? 0;
    const newNode: SGENode = {
      id: inputNode.id,
      x: px,
      y: py,
      vx: 0,
      vy: 0,
      ax: 0,
      ay: 0,
      fx: 0,
      fy: 0,
      pinned: false,
      componentId: 0,
      clusterId: 0,
      degree,
      centrality: degree,
      initialRadius: 0,
      initialAngle: 0,
    };

    // Assign to nearest neighbor's cluster and component
    if (connectedToIds && connectedToIds.length > 0) {
      const firstNeighborIdx = this.nodeIndex.get(connectedToIds[0]);
      if (firstNeighborIdx !== undefined) {
        newNode.componentId = this.nodes[firstNeighborIdx].componentId;
        newNode.clusterId = this.nodes[firstNeighborIdx].clusterId;
      }
    }

    this.nodes.push(newNode);
    this.nodeIndex.set(inputNode.id, this.nodes.length - 1);
    this.adjacency.set(inputNode.id, new Set());
    this.ensureBuffers(this.nodes.length);
    this.reheat();
  }

  /** Remove a node incrementally */
  removeNode(id: number): void {
    const idx = this.nodeIndex.get(id);
    if (idx === undefined) return;

    // Remove from node array
    this.nodes.splice(idx, 1);

    // Rebuild index
    this.nodeIndex.clear();
    for (let i = 0; i < this.nodes.length; i++) {
      this.nodeIndex.set(this.nodes[i].id, i);
    }

    // Remove edges
    this.edges = this.edges.filter(e => e.source !== id && e.target !== id);

    // Remove from adjacency
    const neighbors = this.adjacency.get(id);
    if (neighbors) {
      for (const nid of neighbors) {
        this.adjacency.get(nid)?.delete(id);
        // Update degree
        const nIdx = this.nodeIndex.get(nid);
        if (nIdx !== undefined) {
          this.nodes[nIdx].degree = this.adjacency.get(nid)?.size ?? 0;
        }
      }
    }
    this.adjacency.delete(id);

    this.reheat();
  }

  /** Add an edge incrementally */
  addEdge(edge: SGEEdge): void {
    if (!this.adjacency.has(edge.source) || !this.adjacency.has(edge.target)) return;
    if (edge.source === edge.target) return;
    
    this.edges.push({ source: edge.source, target: edge.target });
    this.adjacency.get(edge.source)!.add(edge.target);
    this.adjacency.get(edge.target)!.add(edge.source);

    const si = this.nodeIndex.get(edge.source);
    const ti = this.nodeIndex.get(edge.target);
    if (si !== undefined) this.nodes[si].degree = this.adjacency.get(edge.source)!.size;
    if (ti !== undefined) this.nodes[ti].degree = this.adjacency.get(edge.target)!.size;

    this.reheat();
  }

  /** Get the number of nodes */
  get nodeCount(): number {
    return this.nodes.length;
  }

  /** Get the number of edges */
  get edgeCount(): number {
    return this.edges.length;
  }

  /** Cleanup — call when destroying the engine */
  dispose(): void {
    this.stop();
    this.nodes = [];
    this.edges = [];
    this.adjacency.clear();
    this.nodeIndex.clear();
    this.spatialGrid.clear();
  }
}


