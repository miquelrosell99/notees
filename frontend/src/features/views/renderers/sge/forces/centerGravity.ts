/**
 * SGE v2 — Per-node center gravity.
 *
 * Pulls every active node toward the origin with a Hookean spring force.
 * Unlike the previous centroid translation, this does not translate the whole
 * graph as a rigid body, so dragging one node no longer perturbs unrelated
 * nodes through the centering force.
 */

import type { ForcePlugin } from './interface';
import type { SGEEngine } from '@/features/views/renderers/sge/engine';

export class CenterGravityForce implements ForcePlugin {
  private engine!: SGEEngine;

  initialize(engine: SGEEngine): void {
    this.engine = engine;
  }

  apply(_alpha: number): void {
    const e = this.engine;
    const strength = e.config.componentCenterStrength;
    if (strength <= 0) return;

    const posX = e.posX, posY = e.posY;
    const ax = e.axBuf, ay = e.ayBuf;
    const activeIdx = e.activeNodeIndices;
    const activeCount = e.activeCount;

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k];
      ax[i] -= posX[i] * strength;
      ay[i] -= posY[i] * strength;
    }
  }
}
