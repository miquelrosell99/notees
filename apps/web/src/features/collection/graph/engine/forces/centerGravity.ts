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

    // The pull is a Hookean spring toward the origin — but UNBOUNDED it
    // dwarfs every local force once a graph is seeded wider than a few
    // thousand units (0.006 · 30k ≈ 180 vs spring forces of ~5), and the
    // whole map collapses ballistically into the center. The cap keeps
    // gravity the gentle gatherer it is meant to be: strong enough to reel
    // in strays, never the dominant term of the balance. Calibrated so an
    // orphan band's gravity equilibrium sits near its seeded spacing
    // (repulsion ≈ 1 at ~20 units apart) — the band reaches balance inside
    // the cooling budget instead of contracting for thousands of ticks.
    const maxAccel = 1;

    const posX = e.posX, posY = e.posY;
    const ax = e.axBuf, ay = e.ayBuf;
    const alphas = e.alphaArr;
    const activeIdx = e.activeNodeIndices;
    const activeCount = e.activeCount;

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k]!;
      const a = alphas[i]!;
      if (a <= 0) continue;
      const x = posX[i]!, y = posY[i]!;
      const dist = Math.sqrt(x * x + y * y);
      if (dist < 1e-6) continue;
      const mag = Math.min(dist * strength, maxAccel) / dist;
      ax[i]! -= x * mag * a;
      ay[i]! -= y * mag * a;
    }
  }
}
