export interface Hlc {
  physical: number;
  logical: number;
}

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physical !== b.physical) return a.physical - b.physical;
  return a.logical - b.logical;
}

export function maxHlc(a: Hlc, b: Hlc): Hlc {
  const cmp = compareHlc(a, b);
  return cmp >= 0 ? { ...a } : { ...b };
}

export class Clock {
  private last: Hlc;

  constructor(_deviceId: string) {
    this.last = { physical: 0, logical: 0 };
  }

  advance(physicalTime: number): Hlc {
    if (physicalTime > this.last.physical) {
      this.last = { physical: physicalTime, logical: 0 };
    } else {
      this.last = { physical: this.last.physical, logical: this.last.logical + 1 };
    }
    return { ...this.last };
  }

  update(received: Hlc, physicalTime: number): Hlc {
    if (physicalTime > this.last.physical && physicalTime > received.physical) {
      this.last = { physical: physicalTime, logical: 0 };
    } else {
      const maxPhysical = Math.max(this.last.physical, received.physical);
      let logical = 0;
      if (maxPhysical === this.last.physical && maxPhysical === received.physical) {
        logical = Math.max(this.last.logical, received.logical) + 1;
      } else if (maxPhysical === this.last.physical) {
        logical = this.last.logical + 1;
      } else {
        logical = received.logical + 1;
      }
      this.last = { physical: maxPhysical, logical };
    }
    return { ...this.last };
  }
}
