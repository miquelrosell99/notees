/**
 * SGE v2 — Centroid-based center force (d3-force style).
 *
 * Matches Obsidian's forceCenter: computes the centroid of all active nodes
 * and applies a uniform translation force that pulls the *center of mass*
 * toward the origin. This prevents the graph from drifting off-screen
 * without compressing nodes into a dense sphere.
 *
 * Unlike the old per-node gravity, every node receives the SAME force vector,
 * so the internal structure (cluster spacing, node distances) is preserved.
 */

import type { ForcePlugin } from './interface';
import type { SGEEngine } from '@/features/content/components/nodes/views/sge/engine';

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

    // Compute centroid
    let cx = 0, cy = 0;
    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k];
      cx += posX[i];
      cy += posY[i];
    }
    cx /= activeCount;
    cy /= activeCount;

    // Pull centroid toward origin — uniform translation, no compression
    const dx = cx * strength;
    const dy = cy * strength;

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k];
      ax[i] -= dx;
      ay[i] -= dy;
    }
  }
}
