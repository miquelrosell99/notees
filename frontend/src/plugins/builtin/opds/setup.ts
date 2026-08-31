/**
 * OPDS plugin frontend setup (notees.opds).
 *
 * Registers the catalog settings tab. The backend owns the feed; this UI is
 * a thin status surface showing the feed URL, the active selection, and the
 * classes served.
 */

import type { PluginContext } from '@/plugins/core';

import { OpdsTab } from './components/OpdsTab';

export function setup(context: PluginContext) {
  context.registerSettingsTab({
    id: 'opds',
    label: 'OPDS Catalog',
    component: OpdsTab,
  });
}
