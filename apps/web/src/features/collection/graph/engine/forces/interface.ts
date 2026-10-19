/**
 * Force plugin interface..
 *
 * Each force law is a self-contained class implementing this interface.
 * The engine composes forces in an array and calls them each tick.
 */

import type { GraphEngine } from '../engine.js';

export interface ForcePlugin {
  /** Called once when the engine topology changes. */
  initialize(engine: GraphEngine): void;
  /**
   * Called every tick. Each force scales its contribution by the per-node
   * activity alpha (`engine.alphaArr`) — a node at alpha 0 feels no force,
   * which is what keeps settled regions frozen during a local reheat.
   */
  apply(): void;
}
