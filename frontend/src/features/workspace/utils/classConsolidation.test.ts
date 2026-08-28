import { describe, expect, it } from 'vitest';

import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { validateConsolidationMapping } from './classConsolidation';

describe('validateConsolidationMapping', () => {
  it('requires both classes', () => {
    expect(validateConsolidationMapping(null, 'x')).toMatch(/both/);
    expect(validateConsolidationMapping('x', null)).toMatch(/both/);
  });

  it('rejects identical classes', () => {
    expect(validateConsolidationMapping('x', 'x')).toMatch(/differ/);
  });

  it('refuses to consolidate a system class', () => {
    expect(
      validateConsolidationMapping(SYSTEM_CLASS_UUIDS.source, SYSTEM_CLASS_UUIDS.book),
    ).toMatch(/System classes/);
  });

  it('accepts an explicit user-class → system-class mapping', () => {
    expect(
      validateConsolidationMapping('11111111-1111-1111-1111-111111111111', SYSTEM_CLASS_UUIDS.source),
    ).toBeNull();
  });
});
