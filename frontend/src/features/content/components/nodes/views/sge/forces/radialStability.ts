/**
 * SGE v2 — Radial stability force.
 *
 * Pulls nodes back toward their initial orbital radius within their cluster,
 * preventing expansion drift.
 */

import type { ForcePlugin } from './interface';
import type { SGEEngine } from '@/features/content/components/nodes/views/sge/engine';

export class RadialStabilityForce implements ForcePlugin {
  private engine!: SGEEngine;

  initialize(engine: SGEEngine): void {
    this.engine = engine;
  }

  apply(_alpha: number): void {
    const e = this.engine;
    const radialStr = e.config.radialStrength;
    if (radialStr <= 0) return;

    const clId = e.clIdArr;
    const clCC = e.clCount;
    const clCx = e.clCx, clCy = e.clCy;
    const posX = e.posX, posY = e.posY;
    const iRad = e.iRadArr;
    const ax = e.axBuf, ay = e.ayBuf;
    const activeIdx = e.activeNodeIndices;
    const activeCount = e.activeCount;

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k];
      const c = clId[i];
      if (clCC[c] === 0) continue;
      const dx = posX[i] - clCx[c], dy = posY[i] - clCy[c];
      const r = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = -radialStr * (r - iRad[i]) / r;
      ax[i] += dx * f;
      ay[i] += dy * f;
    }
  }
}
