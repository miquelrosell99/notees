/**
 * Per-node center gravity..
 *
 * Pulls every active node toward the origin with a Hookean spring force.
 * Unlike the previous centroid translation, this does not translate the whole
 * graph as a rigid body, so dragging one node no longer perturbs unrelated
 * nodes through the centering force.
 */

import type { ForcePlugin } from './interface.js';
import type { GraphEngine } from '../engine.js';

export class CenterGravityForce implements ForcePlugin {
  private engine!: GraphEngine;

  initialize(engine: GraphEngine): void {
    this.engine = engine;
  }

  apply(): void {
    const e = this.engine;
    const strength = e.config.componentCenterStrength;
    if (strength <= 0) return;

    const posX = e.posX, posY = e.posY;
    const ax = e.axBuf, ay = e.ayBuf;
    const alphas = e.alphaArr;
    const activeIdx = e.activeNodeIndices;
    const activeCount = e.activeCount;

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k]!;
      const a = alphas[i]!;
      if (a <= 0) continue;
      ax[i]! -= posX[i]! * strength * a;
      ay[i]! -= posY[i]! * strength * a;
    }
  }
}
