/**
 * SGE v2 — Local repulsion force.
 *
 * Short-range node-node repulsion using a Robin Hood spatial hash
 * for O(N) nearest-neighbour queries.
 */

import type { ForcePlugin } from './interface';
import type { SGEEngine } from '@/features/views/renderers/sge/engine';

export class LocalRepelForce implements ForcePlugin {
  private engine!: SGEEngine;

  initialize(engine: SGEEngine): void {
    this.engine = engine;
  }

  apply(_alpha: number): void {
    const e = this.engine;
    const N = e.n;
    const cfg = e.config;
    const baseRadius = cfg.localRepelRadius;
    const repelRadius = N > 1000 ? baseRadius * Math.min(1, Math.sqrt(1000 / N)) : baseRadius;
    const localStr = cfg.localRepelStrength;
    const repelRadSq = repelRadius * repelRadius;
    const invRepelRad = 1 / repelRadius;
    const pin = e.pinnedArr;
    const posX = e.posX, posY = e.posY;
    const ax = e.axBuf, ay = e.ayBuf;
    const activeIdx = e.activeNodeIndices;
    const activeCount = e.activeCount;

    const grid = e.spatialHash;
    grid.setCellSize(repelRadius);
    grid.clear(N);
    for (let i = 0; i < N; i++) grid.insert(i, posX[i], posY[i]);

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k];
      const nix = posX[i], niy = posY[i];
      const nCount = grid.queryInto(nix, niy);
      const nbuf = grid.resultBuf;
      for (let q = 0; q < nCount; q++) {
        const j = nbuf[q];
        if (j <= i) continue;
        const dx = nix - posX[j], dy = niy - posY[j];
        const distSq = dx * dx + dy * dy;
        if (distSq >= repelRadSq || distSq < 0.01) continue;
        const dist = Math.sqrt(distSq);
        const t = 1 - dist * invRepelRad;
        const env = t * t * t * (t * (t * 6 - 15) + 10);
        const distSafe = Math.max(dist, 4);
        const force = localStr * env / (distSafe * repelRadius);
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        ax[i] += fx; ay[i] += fy;
        if (!pin[j]) { ax[j] -= fx; ay[j] -= fy; }
      }
    }
  }
}
