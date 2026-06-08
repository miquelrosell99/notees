/**
 * SGE v2 — Robin Hood typed-array spatial hash.
 *
 * Open-addressing hash grid for fast nearest-neighbour queries.
 * Used by the local-repulsion force.
 */

function nextPow2(v: number): number {
  let n = 1;
  while (n < v) n <<= 1;
  return n;
}

export class FastSpatialHash {
  private invCell: number;
  private mask = 0;
  private tblKey:  Int32Array = new Int32Array(0);
  private tblHead: Int32Array = new Int32Array(0);
  private tblPSL:  Int8Array  = new Int8Array(0);
  private next:    Int32Array = new Int32Array(0);
  resultBuf: Int32Array = new Int32Array(256);

  constructor(cellSize: number, capacity: number) {
    this.invCell = 1 / cellSize;
    this._alloc(capacity);
  }

  private _alloc(n: number): void {
    const sz     = nextPow2(Math.max(n * 3, 64));
    this.mask    = sz - 1;
    this.tblKey  = new Int32Array(sz).fill(-1);
    this.tblHead = new Int32Array(sz).fill(-1);
    this.tblPSL  = new Int8Array(sz).fill(-1);
    if (this.next.length < n) this.next = new Int32Array(Math.max(n * 2, 256)).fill(-1);
  }

  setCellSize(size: number): void { this.invCell = 1 / size; }

  /** Reset for a new frame. O(tableSize), not O(N). */
  clear(n: number): void {
    const sz = this.mask + 1;
    if (n * 3 > sz) {
      this._alloc(n);
    } else {
      this.tblKey.fill(-1,  0, sz);
      this.tblHead.fill(-1, 0, sz);
      this.tblPSL.fill(-1,  0, sz);
    }
    if (this.next.length < n) this.next = new Int32Array(Math.max(n * 2, 256)).fill(-1);
    this.next.fill(-1, 0, n);
  }

  private cellKey(cx: number, cy: number): number {
    return ((cx * 73856093) ^ (cy * 19349663)) | 0;
  }

  insert(idx: number, x: number, y: number): void {
    const cx  = Math.floor(x * this.invCell) | 0;
    const cy  = Math.floor(y * this.invCell) | 0;
    const targetKey = this.cellKey(cx, cy);
    const mask    = this.mask;
    const tblKey  = this.tblKey;
    const tblHead = this.tblHead;
    const tblPSL  = this.tblPSL;
    const next    = this.next;

    // Phase 1: Robin Hood lookup
    {
      let slot = (targetKey >>> 0) & mask;
      let psl  = 0;
      for (;;) {
        const sp = tblPSL[slot];
        if (sp < 0 || sp < psl) break;
        if (tblKey[slot] === targetKey) {
          next[idx]     = tblHead[slot];
          tblHead[slot] = idx;
          return;
        }
        slot = (slot + 1) & mask;
        psl++;
      }
    }

    // Phase 2: Robin Hood insert
    {
      let probeKey : number = targetKey;
      let probeHead: number = idx;
      let psl      : number = 0;
      let slot = (targetKey >>> 0) & mask;
      for (;;) {
        const sp = tblPSL[slot];
        if (sp < 0) {
          tblKey[slot]  = probeKey;
          tblHead[slot] = probeHead;
          tblPSL[slot]  = psl;
          return;
        }
        if (sp < psl) {
          const tmpK    = tblKey[slot];  tblKey[slot]  = probeKey;  probeKey  = tmpK;
          const tmpH    = tblHead[slot]; tblHead[slot] = probeHead; probeHead = tmpH;
          tblPSL[slot]  = psl;           psl           = sp;
        }
        slot = (slot + 1) & mask;
        psl++;
      }
    }
  }

  /** Fill resultBuf with all nodes in the 3×3 cell neighbourhood. Returns count. */
  queryInto(x: number, y: number): number {
    const cx      = Math.floor(x * this.invCell) | 0;
    const cy      = Math.floor(y * this.invCell) | 0;
    const mask    = this.mask;
    const tblKey  = this.tblKey;
    const tblHead = this.tblHead;
    const tblPSL  = this.tblPSL;
    const next    = this.next;
    let count = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k    = this.cellKey(cx + dx, cy + dy);
        let   slot = (k >>> 0) & mask;
        let   psl  = 0;
        for (;;) {
          const sp = tblPSL[slot];
          if (sp < 0 || sp < psl) break;
          if (tblKey[slot] === k) {
            let cur = tblHead[slot];
            while (cur !== -1) {
              if (count >= this.resultBuf.length) {
                const nb = new Int32Array(this.resultBuf.length * 2);
                nb.set(this.resultBuf.subarray(0, count));
                this.resultBuf = nb;
              }
              this.resultBuf[count++] = cur;
              cur = next[cur];
            }
            break;
          }
          slot = (slot + 1) & mask;
          psl++;
        }
      }
    }
    return count;
  }
}
