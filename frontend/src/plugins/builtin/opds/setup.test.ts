/**
 * OPDS plugin frontend setup tests: settings-tab registration and teardown.
 */
import { describe, expect, it } from 'vitest';

import { createPluginContext, getSettingsTab, type PluginManifest } from '@/plugins/core';
import { setup } from './setup';

const manifest: PluginManifest = {
  id: 'notees.opds',
  name: 'OPDS Catalog',
  version: '1.0.0',
};

describe('opds plugin setup', () => {
  it('registers the OPDS Catalog settings tab and tears it down', () => {
    const context = createPluginContext(manifest);
    setup(context);

    const tab = getSettingsTab('opds');
    expect(tab).toBeDefined();
    expect(tab?.label).toBe('OPDS Catalog');

    context.unregisterAll();
    expect(getSettingsTab('opds')).toBeUndefined();
  });
});
