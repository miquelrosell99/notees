/**
 * SGE v2 — Edge spring force.
 *
 * Hookean springs between linked nodes with per-type rest length and stiffness.
 * Asymmetric: links resist compression more strongly than they resist
 * stretching, making structural links (parent/extends/class) behave like
 * semi-rigid rods while keeping reference links loose.
 */

import type { ForcePlugin } from './interface';
import type { SGEEngine } from '@/features/content/components/nodes/views/sge/engine';

export class SpringForce implements ForcePlugin {
  private engine!: SGEEngine;

  initialize(engine: SGEEngine): void {
    this.engine = engine;
  }

  apply(_alpha: number): void {
    const e = this.engine;
    const cfg = e.config;
    const springStr = cfg.springStrength;
    const E = e.numEdges;
    const pin = e.pinnedArr;
    const posX = e.posX, posY = e.posY;
    const ax = e.axBuf, ay = e.ayBuf;
    const eSrc = e.edgeSrc, eTgt = e.edgeTgt;
    const eRest = e.edgeRest, eStiff = e.edgeStiff;
    const eCompress = e.edgeCompress;

    for (let ei = 0; ei < E; ei++) {
      const si = eSrc[ei], ti = eTgt[ei];
      const dx = posX[ti] - posX[si];
      const dy = posY[ti] - posY[si];
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const compression = dist < eRest[ei] ? eCompress[ei] : 1.0;
      const force = springStr * eStiff[ei] * (dist - eRest[ei]) * compression;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!pin[si]) { ax[si] += fx; ay[si] += fy; }
      if (!pin[ti]) { ax[ti] -= fx; ay[ti] -= fy; }
    }
  }
}
