import { pluginManager } from '../PluginManager';
import type { ContributedSetting } from '../manifest';

export function usePluginManifestSettings(pluginId: string): ContributedSetting[] {
  const plugin = pluginManager.getLoadedPlugin(pluginId);
  return plugin?.manifest?.contributes?.settings ?? [];
}
