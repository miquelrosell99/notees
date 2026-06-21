/**
 * PluginContext passed to frontend plugin setup functions.
 *
 * This is the single integration surface for built-in and external plugins.
 * It wraps existing registries (commands, export formats, view modes) and
 * exposes new registries for settings tabs, slash commands, sidebar items,
 * top-level views, and node actions.
 */

import { registerCommand, type Command } from '@/stores/commandRegistry';
import {
  registerExportFormat,
  unregisterExportFormat,
  type ExportFormatDefinition,
} from '@/features/workspace/components/exportFormatRegistry';
import { registerView as registerNodeCollectionView, type ViewRegistryEntry } from '@/features/views/components/registry';
import { registerPropertyValueRenderer, type PropertyValueRenderer } from '@/features/properties/utils/propertyValueRegistry';

import type { PluginManifest } from './manifest';
import {
  registerImporter,
  unregisterImporter,
  type ImporterDefinition,
} from './importerRegistry';
import {
  registerNodeAction,
  registerSettingsTab,
  registerSidebarItem,
  registerSlashCommand,
  registerView,
  unregisterSettingsTab,
  type NodeActionDefinition,
  type SettingsTabDefinition,
  type SidebarItemDefinition,
  type SlashCommandDefinition,
  type ViewDefinition,
} from './registries';

export interface PluginContext {
  manifest: PluginManifest;

  /** Register a command-palette / keyboard command. */
  registerCommand: (command: Command) => void;

  /** Register an editor slash command. */
  registerSlashCommand: (command: SlashCommandDefinition) => void;

  /** Register a settings-modal tab. */
  registerSettingsTab: (tab: SettingsTabDefinition) => void;

  /** Register a navigation sidebar item. */
  registerSidebarItem: (item: SidebarItemDefinition) => void;

  /** Register a top-level main view (e.g., Flashcards, Zotero Library). */
  registerView: (view: ViewDefinition) => void;

  /** Register a NodeCollection view mode (list, table, graph, etc.). */
  registerNodeCollectionView: (entry: ViewRegistryEntry) => void;

  /** Register an import source. */
  registerImporter: (importer: ImporterDefinition) => void;

  /** Register an export format. */
  registerExportFormat: (format: ExportFormatDefinition) => void;

  /** Register a property value renderer. */
  registerPropertyRenderer: (renderer: PropertyValueRenderer) => void;

  /** Register a node-level action button. */
  registerNodeAction: (action: NodeActionDefinition) => void;

  /** Return a typed HTTP client for the plugin's backend routes. */
  getApiClient: () => { get: (path: string) => Promise<unknown>; post: (path: string, data?: unknown) => Promise<unknown> };

  /** Remove all contributions registered through this context instance. */
  unregisterAll: () => void;
}

export function createPluginContext(manifest: PluginManifest): PluginContext {
  const unregisterCallbacks: Array<() => void> = [];

  const context: PluginContext = {
    manifest,
    registerCommand,
    registerSlashCommand,
    registerSettingsTab: (tab) => {
      registerSettingsTab(tab);
      unregisterCallbacks.push(() => unregisterSettingsTab(tab.id));
    },
    registerSidebarItem,
    registerView,
    registerNodeCollectionView,
    registerImporter: (importer) => {
      registerImporter(importer);
      unregisterCallbacks.push(() => unregisterImporter(importer.id));
    },
    registerExportFormat: (format) => {
      registerExportFormat(format);
      unregisterCallbacks.push(() => unregisterExportFormat(format.format));
    },
    registerPropertyRenderer: registerPropertyValueRenderer,
    registerNodeAction,
    getApiClient: () => ({
      get: async <T = unknown>(path: string) => {
        const { default: apiClient } = await import('@/api/client');
        return apiClient.get<T>(`/plugins/${manifest.id}${path}`);
      },
      post: async <T = unknown>(path: string, data?: unknown) => {
        const { default: apiClient } = await import('@/api/client');
        return apiClient.post<T>(`/plugins/${manifest.id}${path}`, data);
      },
    }),
    unregisterAll: () => {
      unregisterCallbacks.forEach((cb) => cb());
      unregisterCallbacks.length = 0;
    },
  };

  return context;
}
