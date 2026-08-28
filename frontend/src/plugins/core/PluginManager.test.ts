/**
 * Tests for the frontend PluginManager's restartless lifecycle methods:
 * setPluginEnabled (toggle without reload) and refreshPlugins (sync after
 * ZIP install / folder rescan).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/api/client', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

import api from '@/api/client';
import { pluginManager } from './PluginManager';
import type { PluginStatus } from './manifest';

type ManagerInternals = {
  manifests: PluginStatus[];
  loadedPlugins: Map<string, { context: { unregisterAll: () => void } }>;
};

const internals = pluginManager as unknown as ManagerInternals;

function manifest(overrides: Partial<PluginStatus> = {}): PluginStatus {
  return {
    id: 'notees.test',
    name: 'Test Plugin',
    version: '1.0.0',
    enabled: false,
    contributes: {},
    ...overrides,
  };
}

describe('PluginManager.setPluginEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    internals.manifests = [manifest()];
    internals.loadedPlugins.clear();
  });

  it('enables a plugin on the backend and refreshes its cached manifest', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { enabled: true }, headers: {} });
    vi.mocked(api.get).mockResolvedValue({ data: manifest({ enabled: true }), headers: {} });

    const result = await pluginManager.setPluginEnabled('notees.test', true);

    expect(api.post).toHaveBeenCalledWith('/plugins/notees.test/enable');
    expect(api.get).toHaveBeenCalledWith('/plugins/notees.test');
    expect(result.enabled).toBe(true);
    expect(pluginManager.getManifest('notees.test')?.enabled).toBe(true);
  });

  it('disables a plugin and unregisters its frontend contributions', async () => {
    const unregisterAll = vi.fn();
    internals.manifests = [manifest({ enabled: true })];
    internals.loadedPlugins.set('notees.test', { context: { unregisterAll } });
    vi.mocked(api.post).mockResolvedValue({ data: { enabled: false }, headers: {} });
    vi.mocked(api.get).mockResolvedValue({ data: manifest({ enabled: false }), headers: {} });

    const result = await pluginManager.setPluginEnabled('notees.test', false);

    expect(api.post).toHaveBeenCalledWith('/plugins/notees.test/disable');
    expect(result.enabled).toBe(false);
    expect(unregisterAll).toHaveBeenCalledTimes(1);
    expect(pluginManager.isLoaded('notees.test')).toBe(false);
    expect(pluginManager.getManifest('notees.test')?.enabled).toBe(false);
  });
});

describe('PluginManager.refreshPlugins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    internals.manifests = [];
    internals.loadedPlugins.clear();
  });

  it('unloads plugins that were disabled or removed server-side', async () => {
    const goneUnregister = vi.fn();
    const disabledUnregister = vi.fn();
    internals.loadedPlugins.set('notees.gone', { context: { unregisterAll: goneUnregister } });
    internals.loadedPlugins.set('notees.off', { context: { unregisterAll: disabledUnregister } });
    vi.mocked(api.get).mockResolvedValue({
      data: [manifest({ id: 'notees.off', enabled: false })],
      headers: {},
    });

    const manifests = await pluginManager.refreshPlugins();

    expect(manifests).toHaveLength(1);
    expect(goneUnregister).toHaveBeenCalledTimes(1);
    expect(disabledUnregister).toHaveBeenCalledTimes(1);
    expect(pluginManager.isLoaded('notees.gone')).toBe(false);
    expect(pluginManager.isLoaded('notees.off')).toBe(false);
  });

  it('keeps enabled plugins loaded and updates the manifest cache', async () => {
    const unregisterAll = vi.fn();
    internals.loadedPlugins.set('notees.test', { context: { unregisterAll } });
    vi.mocked(api.get).mockResolvedValue({ data: [manifest({ enabled: true })], headers: {} });

    const manifests = await pluginManager.refreshPlugins();

    expect(manifests.map((m) => m.id)).toEqual(['notees.test']);
    expect(unregisterAll).not.toHaveBeenCalled();
    expect(pluginManager.isLoaded('notees.test')).toBe(true);
    expect(pluginManager.getManifests()).toHaveLength(1);
  });
});
