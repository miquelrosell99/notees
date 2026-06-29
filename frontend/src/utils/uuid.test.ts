import { describe, it, expect } from 'vitest';
import { generateUUID, isUuid } from './uuid';

describe('generateUUID', () => {
  it('returns a valid UUID', () => {
    const uuid = generateUUID();
    expect(isUuid(uuid)).toBe(true);
  });

  it('returns a version 7 UUID', () => {
    const uuid = generateUUID();
    // Version nibble is the first hex digit of the third group
    const version = parseInt(uuid.split('-')[2][0], 16);
    expect(version).toBe(7);
  });

  it('uses the RFC 4122 variant', () => {
    const uuid = generateUUID();
    // Variant bits are the two most significant bits of the fourth group
    const variantNibble = parseInt(uuid.split('-')[3][0], 16);
    expect(variantNibble & 0b1100).toBe(0b1000);
  });

  it('encodes a recent timestamp in the first 48 bits', () => {
    const before = Date.now();
    const uuid = generateUUID();
    const after = Date.now();

    const hex = uuid.replace(/-/g, '');
    const timestamp = Number.parseInt(hex.slice(0, 12), 16);

    expect(timestamp).toBeGreaterThanOrEqual(before - 1);
    expect(timestamp).toBeLessThanOrEqual(after + 1);
  });

  it('generates unique values', () => {
    const generated = new Set<string>();
    for (let i = 0; i < 100; i++) {
      generated.add(generateUUID());
    }
    expect(generated.size).toBe(100);
  });
});

describe('isUuid', () => {
  it('accepts valid UUIDs', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUuid('018ff0a0-1234-7def-8abc-1234567890ab')).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
