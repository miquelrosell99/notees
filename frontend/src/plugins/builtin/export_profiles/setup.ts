/**
 * Export Profiles plugin frontend setup (notees.export_profiles).
 *
 * Registers the profile editor as a settings tab. The backend owns profile
 * storage and continuous reconciliation; this UI is a thin editor/status
 * surface over the plugin's REST API.
 */

import type { PluginContext } from '@/plugins/core';

import { ExportProfilesTab } from './components/ExportProfilesTab';

export function setup(context: PluginContext) {
  context.registerSettingsTab({
    id: 'export-profiles',
    label: 'Export Profiles',
    component: ExportProfilesTab,
  });
}
