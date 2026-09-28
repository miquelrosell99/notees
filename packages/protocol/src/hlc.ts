/**
 * Hybrid Logical Clock — causality metadata for v2 envelopes.
 *
 * Semantics (design law, assessment §34.4): the HLC is causality metadata only.
 * The server-assigned `seq` is the sole ordering authority. The HLC never
 * orders the relay log; it resolves last-writer-wins ties in derived state.
 */

import { z } from "zod";

export interface Hlc {
  physical: number;
  logical: number;
}

/** Wire schema: both components must be non-negative integers. */
export const hlcSchema = z
  .object({
    physical: z.number().int().nonnegative(),
    logical: z.number().int().nonnegative(),
  })
  .strict();

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1;
  if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
  return 0;
}

export function maxHlc(a: Hlc, b: Hlc): Hlc {
  return compareHlc(a, b) >= 0 ? a : b;
}

/** Device-bound HLC. Monotonic: never goes backwards across advance/update. */
export class Clock {
  private last: Hlc;

  constructor(deviceId: string, seed?: Hlc) {
    this.deviceId = deviceId;
    this.last = seed ?? { physical: 0, logical: 0 };
  }

  readonly deviceId: string;

  now(physicalTime = Date.now()): Hlc {
    if (physicalTime > this.last.physical) {
      this.last = { physical: physicalTime, logical: 0 };
    } else {
      this.last = { physical: this.last.physical, logical: this.last.logical + 1 };
    }
    return this.last;
  }

  /** Merge a received HLC: max(local, received), ticking the logical counter. */
  update(received: Hlc, physicalTime = Date.now()): Hlc {
    const physical = Math.max(physicalTime, this.last.physical, received.physical);
    let logical = this.last.logical;
    if (physical === this.last.physical && physical === received.physical) {
      logical = Math.max(this.last.logical, received.logical) + 1;
    } else if (physical === this.last.physical) {
      logical = this.last.logical + 1;
    } else if (physical === received.physical) {
      logical = received.logical + 1;
    } else {
      logical = 0;
    }
    this.last = { physical, logical };
    return this.last;
  }

  current(): Hlc {
    return this.last;
  }
}
