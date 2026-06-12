/**
 * SGE v2 — Cluster repulsion force.
 *
 * Pushes community centroids apart using Barnes–Hut when cluster count ≥ 32,
 * otherwise direct O(K²). Forces are distributed evenly to member nodes.
 */

import type { ForcePlugin } from './interface';
import type { SGEEngine } from '@/features/content/components/nodes/views/sge/engine';
import { BHQuadTree, directClusterRepulsion } from '@/features/content/components/nodes/views/sge/barnesHut';

const BH_THRESHOLD = 32;

export class ClusterRepulsionForce implements ForcePlugin {
  private engine!: SGEEngine;
  private bhTree = new BHQuadTree(64);

  initialize(engine: SGEEngine): void {
    this.engine = engine;
  }

  apply(_alpha: number): void {
    const e = this.engine;
    const cfg = e.config;
    const repelStr = cfg.clusterRepelStrength;
    if (repelStr <= 0) return;

    const bigIds = e.bigClusterBuf;
    const bigK = e.bigClusterCount;
    if (bigK <= 0) return;

    const clFx = e.clFx, clFy = e.clFy;
    for (let i = 0; i < bigK; i++) {
      const c = bigIds[i];
      clFx[c] = 0; clFy[c] = 0;
    }

    if (bigK >= BH_THRESHOLD) {
      const root = this.bhTree.build(e.clCx, e.clCy, e.clCount, bigIds, bigK);
      const theta2 = cfg.bhTheta * cfg.bhTheta;
      for (let i = 0; i < bigK; i++) {
        this.bhTree.computeForce(root, bigIds[i], e.clCx, e.clCy, e.clCount, repelStr, theta2, clFx, clFy);
      }
    } else {
      directClusterRepulsion(e.clCx, e.clCy, e.clCount, bigIds, bigK, clFx, clFy, repelStr);
    }

    // Distribute to member nodes
    const clId = e.clIdArr;
    const clCC = e.clCount;
    const ax = e.axBuf, ay = e.ayBuf;
    const activeIdx = e.activeNodeIndices;
    const activeCount = e.activeCount;

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k];
      const c = clId[i];
      const cnt = clCC[c];
      if (cnt <= 1) continue;
      ax[i] += clFx[c] / cnt;
      ay[i] += clFy[c] / cnt;
    }
  }
}
