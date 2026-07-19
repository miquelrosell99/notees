import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestPersistentStorage, isPersisted } from '../storagePersistence';

describe('storagePersistence', () => {
  let originalStorage: StorageManager | undefined;

  beforeEach(() => {
    originalStorage = navigator.storage;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error TypeScript doesn't allow deleting read-only navigator.storage
    delete navigator.storage;
    // @ts-expect-error Assignment to read-only property for test restoration
    navigator.storage = originalStorage;
  });

  it('returns false when navigator.storage is unavailable', async () => {
    // @ts-expect-error Assignment to read-only property for test setup
    navigator.storage = undefined;

    await expect(requestPersistentStorage()).resolves.toBe(false);
    await expect(isPersisted()).resolves.toBe(false);
  });

  it('returns true when persist() resolves true', async () => {
    // @ts-expect-error Assignment to read-only property for test setup
    navigator.storage = {
      persist: vi.fn().mockResolvedValue(true),
      persisted: vi.fn().mockResolvedValue(true),
    } as unknown as StorageManager;

    await expect(requestPersistentStorage()).resolves.toBe(true);
    await expect(isPersisted()).resolves.toBe(true);
  });

  it('returns persisted state correctly', async () => {
    // @ts-expect-error Assignment to read-only property for test setup
    navigator.storage = {
      persist: vi.fn().mockResolvedValue(false),
      persisted: vi.fn().mockResolvedValue(false),
    } as unknown as StorageManager;

    await expect(requestPersistentStorage()).resolves.toBe(false);
    await expect(isPersisted()).resolves.toBe(false);
  });

  it('returns false when persist() rejects', async () => {
    // @ts-expect-error Assignment to read-only property for test setup
    navigator.storage = {
      persist: vi.fn().mockRejectedValue(new Error('Permission denied')),
      persisted: vi.fn().mockRejectedValue(new Error('Permission denied')),
    } as unknown as StorageManager;

    await expect(requestPersistentStorage()).resolves.toBe(false);
    await expect(isPersisted()).resolves.toBe(false);
  });
});
