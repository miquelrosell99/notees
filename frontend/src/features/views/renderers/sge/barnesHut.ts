/**
 * SGE v2 — Barnes–Hut quadtree for cluster repulsion.
 *
 * Pool-based: no heap allocation after the first build.
 */

const BHNF = 4;
const BHNI = 5;

export class BHQuadTree {
  private poolF: Float32Array;
  private poolI: Int32Array;
  private size = 0;
  private cap: number;

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
    this.poolF[f    ] = oldM === 0 ? clx : (this.poolF[f    ] * oldM + clx * clm) / newM;
    this.poolF[f + 1] = oldM === 0 ? cly : (this.poolF[f + 1] * oldM + cly * clm) / newM;
    this.poolF[f + 2] = newM;

    const leafIdx = this.poolI[ii + 4];
    const half    = this.poolF[f + 3];
    const quarter = half * 0.5;
    const ncx     = this.poolF[f    ];
    const ncy     = this.poolF[f + 1];

    if (leafIdx === -1 && this.poolI[ii] === -1) {
      this.poolI[ii + 4] = clIdx;
      return;
    }

    if (leafIdx !== -1) {
      this.poolI[ii + 4] = -1;
      const child = this._getOrCreateChild(node, leafIdx, cx, cy, ncx, ncy, quarter);
      const cf  = child * BHNF;
      this.poolF[cf + 2] = 0;
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
      const distSafe = Math.max(dist, 20);
      const f_   = repelStr * Math.sqrt(aMass * nmass) / (distSafe * 200);
      fxOut[aIdx] += (dx / dist) * f_;
      fyOut[aIdx] += (dy / dist) * f_;
      return;
    }

    const size2 = half * half * 4;
    if (size2 < theta2 * distSq) {
      if (distSq < 0.01 || nmass === 0) return;
      const dist = Math.sqrt(distSq);
      const distSafe = Math.max(dist, 20);
      const f_   = repelStr * Math.sqrt(aMass * nmass) / (distSafe * 200);
      fxOut[aIdx] += (dx / dist) * f_;
      fyOut[aIdx] += (dy / dist) * f_;
      return;
    }

    for (let q = 0; q < 4; q++) {
      this._traverse(this.poolI[ii + q], aIdx, ax, ay, aMass, cx, cy, cc, repelStr, theta2, fxOut, fyOut);
    }
  }
}

/** Direct O(K²) cluster repulsion for small K (cheaper than building BH tree). */
export function directClusterRepulsion(
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
      const distSafe = Math.max(dist, 20);
      const force = repelStr * Math.sqrt(cc[ai] * cc[bi]) / (distSafe * 200);
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      clFx[ai] += fx; clFy[ai] += fy;
      clFx[bi] -= fx; clFy[bi] -= fy;
    }
  }
}
