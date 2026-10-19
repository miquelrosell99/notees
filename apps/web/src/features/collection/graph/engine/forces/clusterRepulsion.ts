/**
 * Cluster repulsion force..
 *
 * Pushes community centroids apart with a size-aware soft shell — contact
 * repulsion proportional to overlap of the clusters' radii plus the
 * separation margin — on top of the long-range Barnes–Hut 1/d term that
 * keeps the global spread. Forces are distributed to member nodes as
 * clFx/√cnt so a large community moves as a unit.
 */

import type { ForcePlugin } from './interface.js';
import type { GraphEngine } from '../engine.js';
import { BHQuadTree, directClusterRepulsion } from '../barnesHut.js';

const BH_THRESHOLD = 32;

export class ClusterRepulsionForce implements ForcePlugin {
  private engine!: GraphEngine;
  private bhTree = new BHQuadTree(64);

  initialize(engine: GraphEngine): void {
    this.engine = engine;
  }

  apply(): void {
    const e = this.engine;
    const cfg = e.config;
    const repelStr = cfg.clusterRepelStrength;
    if (repelStr <= 0) return;

    const bigIds = e.bigClusterBuf;
    const bigK = e.bigClusterCount;
    if (bigK <= 0) return;

    const clFx = e.clFx, clFy = e.clFy;
    for (let i = 0; i < bigK; i++) {
      const c = bigIds[i]!;
      clFx[c] = 0; clFy[c] = 0;
    }

    if (bigK >= BH_THRESHOLD) {
      const root = this.bhTree.build(e.clCx, e.clCy, e.clCount, bigIds, bigK);
      const theta2 = cfg.bhTheta * cfg.bhTheta;
      for (let i = 0; i < bigK; i++) {
        this.bhTree.computeForce(root, bigIds[i]!, e.clCx, e.clCy, e.clCount, repelStr, theta2, clFx, clFy, cfg.clusterMargin, cfg.clusterShellStrength, cfg.idealDistance);
      }
    } else {
      directClusterRepulsion(e.clCx, e.clCy, e.clCount, bigIds, bigK, clFx, clFy, repelStr, e.clRad, cfg.clusterMargin, cfg.clusterShellStrength);
    }

    // Distribute to member nodes — √cnt, not cnt, so a large community moves
    // as a unit instead of having its push diluted per member.
    const clId = e.clIdArr;
    const clCC = e.clCount;
    const ax = e.axBuf, ay = e.ayBuf;
    const alphas = e.alphaArr;
    const activeIdx = e.activeNodeIndices;
    const activeCount = e.activeCount;

    for (let k = 0; k < activeCount; k++) {
      const i = activeIdx[k]!;
      const c = clId[i]!;
      const cnt = clCC[c]!;
      if (cnt <= 1) continue;
      const a = alphas[i]!;
      if (a <= 0) continue;
      const share = a / Math.sqrt(cnt);
      ax[i]! += clFx[c]! * share;
      ay[i]! += clFy[c]! * share;
    }
  }
}
