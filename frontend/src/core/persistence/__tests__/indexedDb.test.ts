import { describe, it, expect, beforeEach } from 'vitest';
import {
  deleteWorkspaceDatabase,
  loadWorkspaceDatabase,
  saveWorkspaceDatabase,
  validateIndexedDb,
} from '../indexedDb';

describe('indexedDb persistence', () => {
  beforeEach(async () => {
    await deleteWorkspaceDatabase('ws-test');
  });

  it('saves and loads a workspace database', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await saveWorkspaceDatabase('ws-test', data);
    const loaded = await loadWorkspaceDatabase('ws-test');
    expect(loaded).toBeDefined();
    expect(Array.from(loaded!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns undefined when no database exists', async () => {
    const loaded = await loadWorkspaceDatabase('ws-missing');
    expect(loaded).toBeUndefined();
  });

  it('deletes a saved database', async () => {
    const data = new Uint8Array([9, 8, 7]);
    await saveWorkspaceDatabase('ws-test', data);
    await deleteWorkspaceDatabase('ws-test');
    const loaded = await loadWorkspaceDatabase('ws-test');
    expect(loaded).toBeUndefined();
  });

  it('overwrites an existing database', async () => {
    await saveWorkspaceDatabase('ws-test', new Uint8Array([1, 1, 1]));
    await saveWorkspaceDatabase('ws-test', new Uint8Array([2, 2, 2]));
    const loaded = await loadWorkspaceDatabase('ws-test');
    expect(Array.from(loaded!)).toEqual([2, 2, 2]);
  });

  it('validates that IndexedDB can be opened', async () => {
    await expect(validateIndexedDb()).resolves.toBe(true);
  });
});
