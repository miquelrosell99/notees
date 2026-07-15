import { describe, it, expect, beforeEach } from 'vitest';
import {
  setUserData,
  getUserData,
  clearUserData,
  setApiKey,
  getApiKey,
  clearApiKey,
  isAuthenticated,
} from '@/utils/auth';

describe('auth storage (web storage path)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips user data through localStorage', () => {
    const user = { id: 1, email: 'a@b.c' };
    setUserData(user);
    expect(getUserData()).toEqual(user);
    expect(isAuthenticated()).toBe(true);
  });

  it('returns null for missing or corrupt user data', () => {
    expect(getUserData()).toBeNull();
    localStorage.setItem('user', '{not json');
    expect(getUserData()).toBeNull();
  });

  it('clears user data', () => {
    setUserData({ id: 1 });
    clearUserData();
    expect(getUserData()).toBeNull();
    expect(isAuthenticated()).toBe(false);
  });

  it('round-trips the API key through localStorage', () => {
    expect(getApiKey()).toBeNull();
    setApiKey('k123');
    expect(getApiKey()).toBe('k123');
    clearApiKey();
    expect(getApiKey()).toBeNull();
  });
});
