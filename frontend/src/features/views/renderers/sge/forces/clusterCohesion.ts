/**
 * SGE v2 — Cluster cohesion force (shell model).
 *
 * Pulls nodes toward their community centroid, preferring an orbital shell
 * at radius `idealDistance * 0.5 * sqrt(clusterSize)`.
 */

import type { ForcePlugin } from './interface';
import type { SGEEngine } from '@/features/views/renderers/sge/engine';

export class ClusterCohesionForce implements ForcePlugin {
  private engine!: SGEEngine;

  initialize(engine: SGEEngine): void {
    this.engine = engine;
  }

  apply(_alpha: number): void {
    const e = this.engine;
    const N = e.n;
    const cfg = e.config;
    const clusterStr = cfg.clusterStrength;
    if (clusterStr <= 0) return;
    const idealDist = cfg.idealDistance;
    const pin = e.pinnedArr;
    const clId = e.clIdArr;
    const clCx = e.clCx, clCy = e.clCy, clCC = e.clCount;
    const posX = e.posX, posY = e.posY;
    const ax = e.axBuf, ay = e.ayBuf;

    for (let i = 0; i < N; i++) {
      if (pin[i]) continue;
      const c = clId[i];
      const cnt = clCC[c];
      if (cnt <= 1) continue;
      const dx = posX[i] - clCx[c], dy = posY[i] - clCy[c];
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const shellR = Math.min(idealDist * 0.5 * Math.sqrt(cnt), idealDist * 6);
      const err = dist - shellR;
      const f = (err > 0 ? -clusterStr * err : -clusterStr * err * 0.15) / dist;
      ax[i] += dx * f;
      ay[i] += dy * f;
    }
  }
}
