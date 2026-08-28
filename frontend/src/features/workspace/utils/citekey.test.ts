import { describe, expect, it } from 'vitest';

import {
  CITEKEY_PATTERN_SETTING_KEY,
  DEFAULT_CITEKEY_PATTERN,
  getCitekeyPattern,
  validateCitekeyPattern,
} from './citekey';

describe('getCitekeyPattern', () => {
  it('falls back to the default when settings are missing', () => {
    expect(getCitekeyPattern(undefined)).toBe(DEFAULT_CITEKEY_PATTERN);
    expect(getCitekeyPattern({})).toBe(DEFAULT_CITEKEY_PATTERN);
  });

  it('falls back to the default for blank or non-string values', () => {
    expect(getCitekeyPattern({ [CITEKEY_PATTERN_SETTING_KEY]: '  ' })).toBe(
      DEFAULT_CITEKEY_PATTERN,
    );
    expect(getCitekeyPattern({ [CITEKEY_PATTERN_SETTING_KEY]: 42 })).toBe(
      DEFAULT_CITEKEY_PATTERN,
    );
  });

  it('returns the stored pattern', () => {
    expect(getCitekeyPattern({ [CITEKEY_PATTERN_SETTING_KEY]: '{title_word}{year}' })).toBe(
      '{title_word}{year}',
    );
  });
});

describe('validateCitekeyPattern', () => {
  it('accepts the default pattern', () => {
    expect(validateCitekeyPattern(DEFAULT_CITEKEY_PATTERN)).toBeNull();
  });

  it('accepts literals and modifiers', () => {
    expect(validateCitekeyPattern('{organization_name:upper}-{year}')).toBeNull();
  });

  it('rejects empty patterns', () => {
    expect(validateCitekeyPattern('   ')).toMatch(/empty/);
  });

  it('rejects unknown tokens', () => {
    expect(validateCitekeyPattern('{author}{year}')).toMatch(/Unknown token/);
  });
});
