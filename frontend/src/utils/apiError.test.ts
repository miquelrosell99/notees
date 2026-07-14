import { describe, it, expect } from 'vitest';
import { getApiErrorMessage } from './apiError';

describe('getApiErrorMessage', () => {
  it('reads a coded { code, message } detail (property enforcement errors)', () => {
    const error = {
      response: { data: { detail: { code: 'required_property', message: 'Status is required and has no default' } } },
    };
    expect(getApiErrorMessage(error, 'fallback')).toBe('Status is required and has no default');
  });

  it('reads a plain string detail', () => {
    const error = { response: { data: { detail: 'Property not found' } } };
    expect(getApiErrorMessage(error, 'fallback')).toBe('Property not found');
  });

  it('ignores a coded detail without a usable message', () => {
    const error = { response: { data: { detail: { code: 'required_property' } } } };
    expect(getApiErrorMessage(error, 'fallback')).toBe('fallback');
  });

  it('falls back to the Error message when there is no response body', () => {
    expect(getApiErrorMessage(new Error('Network down'), 'fallback')).toBe('Network down');
  });

  it('returns the fallback for anything else', () => {
    expect(getApiErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(getApiErrorMessage(null, 'fallback')).toBe('fallback');
    expect(getApiErrorMessage('oops', 'fallback')).toBe('fallback');
  });
});
