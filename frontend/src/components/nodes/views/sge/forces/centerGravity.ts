/**
 * SGE v2 — Per-node gravity well toward the origin.
 *
 * Applies a force proportional to each node's distance from the origin:
 *   a = -strength * position
 *
 * This pulls far-away isolated nodes inward strongly while barely
 * affecting the tightly-connected core, preserving internal structure.
 * Unlike centroid gravity, it actually reduces the distance between
 * disconnected nodes and the main component over time.
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
