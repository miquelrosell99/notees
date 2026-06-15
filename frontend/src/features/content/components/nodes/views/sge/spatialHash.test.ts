import { describe, it, expect } from 'vitest';
import { FastSpatialHash } from './spatialHash';

describe('FastSpatialHash', () => {
  it('finds a nearby point in the same cell', () => {
    const hash = new FastSpatialHash(10, 16);
    hash.clear(2);
    hash.insert(0, 5, 5);
    hash.insert(1, 100, 100);
    const count = hash.queryInto(6, 6);
    const found = hash.resultBuf.slice(0, count);
    expect(found).toContain(0);
    expect(found).not.toContain(1);
  });

  it('finds points in neighbouring cells', () => {
    const hash = new FastSpatialHash(10, 16);
    hash.clear(3);
    hash.insert(0, 9, 9);
    hash.insert(1, 11, 11);
    hash.insert(2, 100, 100);
    const count = hash.queryInto(10, 10);
    const found = hash.resultBuf.slice(0, count);
    expect(found).toContain(0);
    expect(found).toContain(1);
    expect(found).not.toContain(2);
  });

  it('grows result buffer when many points share a cell', () => {
    const hash = new FastSpatialHash(100, 4);
    hash.clear(20);
    for (let i = 0; i < 20; i++) hash.insert(i, 5, 5);
    const count = hash.queryInto(5, 5);
    expect(count).toBe(20);
    const found = hash.resultBuf.slice(0, count);
    for (let i = 0; i < 20; i++) expect(found).toContain(i);
  });
});
