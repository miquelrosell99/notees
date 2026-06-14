import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// ResizeObserver is not available in jsdom; provide a minimal mock so
// components that measure DOM layout can render in tests.
global.ResizeObserver = class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(_callback: ResizeObserverCallback) {}
};

afterEach(() => {
  cleanup();
});
