/**
 * PluginManager loads plugin manifests from the backend and executes each
 * enabled plugin's frontend setup() function.
 *
 * Built-in plugins are statically imported; user-installed plugins are loaded
 * dynamically from data/plugins/<id>/dist/.
 *
 * Runtime load/unload/reload lets administrators activate, deactivate, and
 * refresh plugins without a full page reload.
 */

import api from '@/api/client';
import { getLogger } from '@/utils/logger';
import { registerExportFormat } from '@/features/workspace/components/exportFormatRegistry';

import type { PluginManifest, PluginStatus } from './manifest';
import { createPluginContext, type PluginContext } from './PluginContext';
import { registerSettingsTab } from './registries';
import { registerImporter, type ImporterDefinition } from './importerRegistry';
import { PluginSettingsTab } from './components/PluginSettingsTab';

const logger = getLogger('plugins');

interface PluginModule {
  setup?: (context: PluginContext) => void | Promise<void>;
}

interface LoadedPlugin {
  manifest: PluginStatus;
  module: PluginModule | null;
  context: PluginContext;
}

class PluginManager {
  private manifests: PluginStatus[] = [];
  private loadedPlugins = new Map<string, LoadedPlugin>();
  private loaded = false;

  async loadPlugins(): Promise<void> {
    if (this.loaded) return;

    try {
      const response = await api.get('/plugins');
      this.manifests = (response.data as PluginStatus[]) ?? [];
    } catch (error) {
      logger.error('Failed to fetch plugin manifests', error);
      this.manifests = [];
    }

    for (const manifest of this.manifests) {
      if (!manifest.enabled) continue;
      await this.loadPluginFrontend(manifest);
    }

    this.loaded = true;
  }

  /** Runtime load: activate a plugin that is already installed. */
  async loadPlugin(pluginId: string): Promise<PluginStatus | undefined> {
    const response = await api.post(`/plugins/${pluginId}/load`);
    const manifest = response.data as PluginStatus;

    // Refresh our cached manifest list.
    const idx = this.manifests.findIndex((m) => m.id === pluginId);
    if (idx >= 0) {
      this.manifests[idx] = manifest;
    } else {
      this.manifests.push(manifest);
    }

    await this.loadPluginFrontend(manifest);
    return manifest;
  }

  /** Runtime unload: deactivate a plugin and clean up its contributions. */
  async unloadPlugin(pluginId: string): Promise<boolean> {
    try {
      await api.post(`/plugins/${pluginId}/unload`);
    } catch (error) {
      logger.error(`Failed to unload plugin ${pluginId} on backend`, error);
      return false;
    }

    const loaded = this.loadedPlugins.get(pluginId);
    if (loaded) {
      loaded.context.unregisterAll();
      this.loadedPlugins.delete(pluginId);
    }

    const idx = this.manifests.findIndex((m) => m.id === pluginId);
    if (idx >= 0) {
      this.manifests[idx] = { ...this.manifests[idx], enabled: false };
    }

    return true;
  }

  /** Runtime reload: refresh a plugin's code and re-register contributions. */
  async reloadPlugin(pluginId: string): Promise<PluginStatus | undefined> {
    const loaded = this.loadedPlugins.get(pluginId);
    if (loaded) {
      loaded.context.unregisterAll();
      this.loadedPlugins.delete(pluginId);
    }

    const response = await api.post(`/plugins/${pluginId}/reload`);
    const manifest = response.data as PluginStatus;

    const idx = this.manifests.findIndex((m) => m.id === pluginId);
    if (idx >= 0) {
      this.manifests[idx] = manifest;
    } else {
      this.manifests.push(manifest);
    }

    await this.loadPluginFrontend(manifest);
    return manifest;
  }

  private async loadPluginFrontend(manifest: PluginStatus): Promise<void> {
    if (this.loadedPlugins.has(manifest.id)) {
      // Already loaded; avoid duplicate setup.
      return;
    }

    if (!manifest.frontend?.entrypoint) {
      // Backend-only plugin; still register generic contributions.
      this.registerGenericContributions(manifest);
      return;
    }

    try {
      const pluginModule = await this.importPlugin(manifest);
      const context = createPluginContext(manifest);

      this.registerGenericContributions(manifest, context);

      if (pluginModule?.setup) {
        await pluginModule.setup(context);
      }

      this.loadedPlugins.set(manifest.id, { manifest, module: pluginModule, context });
    } catch (error) {
      manifest.frontendSetupFailed = true;
      manifest.frontendError = error instanceof Error ? error.message : String(error);
      logger.error(`Plugin ${manifest.id} frontend setup failed`, error);
    }
  }

  private registerGenericContributions(manifest: PluginManifest, context?: PluginContext): void {
    const settings = manifest.contributes?.settings ?? [];
    if (settings.length > 0) {
      const tabId = `plugin-settings-${manifest.id}`;
      const def = {
        id: tabId,
        label: manifest.name,
        component: () => PluginSettingsTab({ pluginId: manifest.id }),
      };
      if (context) {
        context.registerSettingsTab(def);
      } else {
        registerSettingsTab(def);
      }
    }

    const exporters = manifest.contributes?.exportFormats ?? [];
    for (const exporter of exporters) {
      const def = {
        format: exporter.id,
        label: exporter.label,
        extension: exporter.extension,
        mimeType: exporter.mimeType ?? 'application/octet-stream',
        supportsPreview: false,
        hasHtmlOptions: false,
        supportsCssOverrides: false,
        icon: 'file-export',
      };
      if (context) {
        context.registerExportFormat(def);
      } else {
        registerExportFormat(def);
      }
    }

    const importers = manifest.contributes?.importers ?? [];
    for (const importer of importers) {
      const def: ImporterDefinition = {
        id: importer.id,
        label: importer.label,
        fileExtensions: importer.fileExtensions,
        pluginId: manifest.id,
      };
      if (context) {
        context.registerImporter(def);
      } else {
        registerImporter(def);
      }
    }
  }

  private async importPlugin(manifest: PluginManifest): Promise<PluginModule | null> {
    if (manifest.builtin) {
      const safeId = manifest.id.replace(/\./g, '_');
      try {
        const module = await import(`@/plugins/builtin/${safeId}/setup`);
        return module as PluginModule;
      } catch {
        const module = await import(`@/plugins/builtin/${manifest.id}/setup`);
        return module as PluginModule;
      }
    }

    const baseUrl = `/data/plugins/${manifest.id}`;
    const entrypoint = `${baseUrl}/${manifest.frontend!.entrypoint}`;
    const module = await import(/* webpackIgnore: true */ entrypoint);
    return module as PluginModule;
  }

  getManifests(): PluginStatus[] {
    return this.manifests;
  }

  getManifest(id: string): PluginStatus | undefined {
    return this.manifests.find((m) => m.id === id);
  }

  getLoadedPlugin(id: string): LoadedPlugin | undefined {
    return this.loadedPlugins.get(id);
  }

  isLoaded(id: string): boolean {
    return this.loadedPlugins.has(id);
  }
}

export const pluginManager = new PluginManager();
