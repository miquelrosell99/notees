/**
 * SGE v2 — Force plugin interface.
 *
 * Each force law is a self-contained class implementing this interface.
 * The engine composes forces in an array and calls them each tick.
 */

import type { SGEEngine } from '@/features/content/components/nodes/views/sge/engine';

export interface ForcePlugin {
  /** Called once when the engine topology changes. */
  initialize(engine: SGEEngine): void;
  /** Called every tick. Alpha is the current cooling parameter (0..1). */
  apply(alpha: number): void;
}
