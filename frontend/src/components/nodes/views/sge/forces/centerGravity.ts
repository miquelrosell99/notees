/**
 * SGE v2 — Center gravity + isolate soft wall.
 *
 * Connected nodes feel linear gravity toward the origin (stronger for hubs).
 * Isolated nodes (degree=0) are pushed outward to a target radius so they
 * don't collapse into the centre.
 */

import type { ForcePlugin } from './interface';
import type { SGEEngine } from '../engine';

export class CenterGravityForce implements ForcePlugin {
  private engine!: SGEEngine;

  initialize(engine: SGEEngine): void {
    this.engine = engine;
  }

  apply(_alpha: number): void {
    const e = this.engine;
    const centerStr = e.config.componentCenterStrength;
    if (centerStr <= 0) return;

    const targetR = e.config.idealDistance * 8;
    const eps = 0.001;
    const degArr = e.degArr;
    const posX = e.posX, posY = e.posY;
    const ax = e.axBuf, ay = e.ayBuf;
    const activeIdx = e.activeNodeIndices;
    const activeCount = e.activeCount;

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k];
      const degree = degArr[i];
      const scale = 0.5 + Math.min(degree * 0.1, 2.5);
      const strength = centerStr * scale;

      if (degree === 0) {
        const dx = posX[i], dy = posY[i];
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r < targetR) {
          const f = strength * (targetR - r);
          if (r > eps) {
            ax[i] += (dx / r) * f;
            ay[i] += (dy / r) * f;
          } else {
            ax[i] += f;
          }
        }
      } else {
        ax[i] -= strength * posX[i];
        ay[i] -= strength * posY[i];
      }
    }
  }
}
