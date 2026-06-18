/**
 * SGE v2 — Component bubble force.
 *
 * Each connected component exerts a repulsive bubble around its centroid,
 * keeping separate components from overlapping.
 */

import type { ForcePlugin } from './interface';
import type { SGEEngine } from '@/features/views/renderers/sge/engine';

export class ComponentBubbleForce implements ForcePlugin {
  private engine!: SGEEngine;

  // Reusable buffers; grown only when component count increases.
  private cx: Float32Array = new Float32Array(0);
  private cy: Float32Array = new Float32Array(0);
  private cc: Int32Array   = new Int32Array(0);
  private cfx: Float32Array = new Float32Array(0);
  private cfy: Float32Array = new Float32Array(0);
  private cap = 0;

  initialize(engine: SGEEngine): void {
    this.engine = engine;
  }

  private ensureCap(C: number): void {
    if (C <= this.cap) return;
    const c = Math.max(C, 16);
    this.cx  = new Float32Array(c);
    this.cy  = new Float32Array(c);
    this.cc  = new Int32Array(c);
    this.cfx = new Float32Array(c);
    this.cfy = new Float32Array(c);
    this.cap = c;
  }

  apply(_alpha: number): void {
    const e = this.engine;
    const N = e.n;
    const compId = e.compIdArr;
    const posX = e.posX, posY = e.posY;
    const ax = e.axBuf, ay = e.ayBuf;
    const activeIdx = e.activeNodeIndices;
    const activeCount = e.activeCount;

    // Gather component centroids
    let maxCompId = 0;
    for (let i = 0; i < N; i++) { if (compId[i] > maxCompId) maxCompId = compId[i]; }
    const C = maxCompId + 1;
    this.ensureCap(C);

    const cx = this.cx, cy = this.cy, cc = this.cc;
    const cfx = this.cfx, cfy = this.cfy;
    cx.fill(0, 0, C); cy.fill(0, 0, C); cc.fill(0, 0, C);
    cfx.fill(0, 0, C); cfy.fill(0, 0, C);

    for (let i = 0; i < N; i++) {
      const c = compId[i];
      cx[c] += posX[i]; cy[c] += posY[i]; cc[c]++;
    }
    for (let c = 0; c < C; c++) { if (cc[c] > 0) { cx[c] /= cc[c]; cy[c] /= cc[c]; } }

    // Pairwise repulsion between centroids
    const compRepelStr = 2500;
    const compRepelRadius = 600;
    for (let a = 0; a < C; a++) {
      if (cc[a] === 0) continue;
      for (let b = a + 1; b < C; b++) {
        if (cc[b] === 0) continue;
        const dx = cx[a] - cx[b], dy = cy[a] - cy[b];
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const t = 1 - dist / compRepelRadius;
        if (t <= 0) continue;
        const f = compRepelStr * t * t / dist;
        const fx = dx * f, fy = dy * f;
        cfx[a] += fx; cfy[a] += fy;
        cfx[b] -= fx; cfy[b] -= fy;
      }
    }

    // Cap total force per component
    const maxCompAccel = 1.0;
    for (let c = 0; c < C; c++) {
      if (cc[c] <= 0) continue;
      const maxTotal = maxCompAccel * cc[c];
      const totalMag = Math.sqrt(cfx[c] * cfx[c] + cfy[c] * cfy[c]);
      if (totalMag > maxTotal) {
        const s = maxTotal / totalMag;
        cfx[c] *= s; cfy[c] *= s;
      }
    }

    // Distribute to member nodes
    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k];
      const c = compId[i];
      if (cc[c] <= 0) continue;
      ax[i] += cfx[c] / cc[c];
      ay[i] += cfy[c] / cc[c];
    }
  }
}
