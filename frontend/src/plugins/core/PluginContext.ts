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
import {
  registerView as registerNodeCollectionView,
  unregisterView as unregisterNodeCollectionView,
  type ViewRegistryEntry,
} from '@/features/views/components/registry';
import {
  registerPropertyValueRenderer,
  unregisterPropertyValueRenderer,
  type PropertyValueRenderer,
} from '@/features/properties/utils/propertyValueRegistry';

import type { PluginManifest } from './manifest';
import {
  registerImporter,
  unregisterImporter,
  type ImporterDefinition,
} from './importerRegistry';
import { viewPrimitives, type ViewPrimitives } from './primitives';
import {
  registerNodeAction,
  registerSettingsTab,
  registerSidebarItem,
  registerSlashCommand,
  registerView,
  unregisterNodeAction,
  unregisterSettingsTab,
  unregisterSidebarItem,
  unregisterSlashCommand,
  unregisterView,
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

  /**
   * App view primitives for composing custom views (QueryNodeCollection,
   * NodeSelector, PropertiesSection, PageViewHeader, ...).
   * See `primitives.ts` for the documented surface.
   */
  primitives: ViewPrimitives;

  /** Return a typed HTTP client for the plugin's backend routes. */
  getApiClient: () => { get: (path: string) => Promise<unknown>; post: (path: string, data?: unknown) => Promise<unknown> };

  /** Remove all contributions registered through this context instance. */
  unregisterAll: () => void;
}

export function createPluginContext(manifest: PluginManifest): PluginContext {
  const unregisterCallbacks: Array<() => void> = [];

  const context: PluginContext = {
    manifest,
    registerCommand: (command) => {
      const unregister = registerCommand(command);
      unregisterCallbacks.push(unregister);
    },
    registerSlashCommand: (command) => {
      registerSlashCommand(command);
      unregisterCallbacks.push(() => unregisterSlashCommand(command.id));
    },
    registerSettingsTab: (tab) => {
      registerSettingsTab(tab);
      unregisterCallbacks.push(() => unregisterSettingsTab(tab.id));
    },
    registerSidebarItem: (item) => {
      registerSidebarItem(item);
      unregisterCallbacks.push(() => unregisterSidebarItem(item.id));
    },
    registerView: (view) => {
      registerView(view);
      unregisterCallbacks.push(() => unregisterView(view.viewId));
    },
    registerNodeCollectionView: (entry) => {
      registerNodeCollectionView(entry);
      unregisterCallbacks.push(() => unregisterNodeCollectionView(entry.id));
    },
    registerImporter: (importer) => {
      registerImporter(importer);
      unregisterCallbacks.push(() => unregisterImporter(importer.id));
    },
    registerExportFormat: (format) => {
      registerExportFormat(format);
      unregisterCallbacks.push(() => unregisterExportFormat(format.format));
    },
    registerPropertyRenderer: (renderer) => {
      registerPropertyValueRenderer(renderer);
      unregisterCallbacks.push(() => unregisterPropertyValueRenderer(renderer.type));
    },
    registerNodeAction: (action) => {
      registerNodeAction(action);
      unregisterCallbacks.push(() => unregisterNodeAction(action.id));
    },
    primitives: viewPrimitives,
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
