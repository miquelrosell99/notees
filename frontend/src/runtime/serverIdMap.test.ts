/**
 * Tests for serverIdMap.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearServerId,
  getServerId,
  registerServerId,
  remapBlockId,
} from './serverIdMap';

describe('serverIdMap', () => {
  beforeEach(() => {
    clearServerId('block-a');
    clearServerId('block-b');
  });

  it('registers and resolves server UUIDs bidirectionally', () => {
    registerServerId('block-a', '550e8400-e29b-41d4-a716-446655440000');
    expect(getServerId('block-a')).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('remaps a temporary block id to a canonical server id', () => {
    registerServerId('temp-a', '550e8400-e29b-41d4-a716-446655440000');
    remapBlockId('temp-a', 'block-a');
    expect(getServerId('block-a')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(getServerId('temp-a')).toBeNull();
  });

  it('returns null for unregistered block ids', () => {
    expect(getServerId('unknown')).toBeNull();
  });
});
