/**
 * Frontend registries for plugin-contributed extension points.
 *
 * These follow the same module-level Map pattern as the existing command,
 * export-format, and view registries.
 */

import type { ComponentType, LazyExoticComponent } from 'react';

import type { MainViewType } from '@/stores/appStore';

import type {
  ContributedSidebarItem,
  ContributedSlashCommand,
  ContributedView,
} from './manifest';

// ── Settings Tab Registry ────────────────────────────────────────────────────

export interface SettingsTabDefinition {
  id: string;
  label: string;
  component: ComponentType;
}

const settingsTabRegistry = new Map<string, SettingsTabDefinition>();

export function registerSettingsTab(def: SettingsTabDefinition): void {
  settingsTabRegistry.set(def.id, def);
}

export function unregisterSettingsTab(id: string): void {
  settingsTabRegistry.delete(id);
}

export function getSettingsTab(id: string): SettingsTabDefinition | undefined {
  return settingsTabRegistry.get(id);
}

export function getRegisteredSettingsTabs(): SettingsTabDefinition[] {
  return Array.from(settingsTabRegistry.values());
}

// ── Slash Command Registry ───────────────────────────────────────────────────

export interface SlashCommandDefinition extends ContributedSlashCommand {
  /** Execute the slash command. Receives the current editor and block id. */
  execute: (payload: { editor: unknown; blockServerId: number | null }) => void;
}

const slashCommandRegistry = new Map<string, SlashCommandDefinition>();

export function registerSlashCommand(def: SlashCommandDefinition): void {
  slashCommandRegistry.set(def.id, def);
}

export function getSlashCommand(id: string): SlashCommandDefinition | undefined {
  return slashCommandRegistry.get(id);
}

export function getRegisteredSlashCommands(): SlashCommandDefinition[] {
  return Array.from(slashCommandRegistry.values());
}

// ── Sidebar Item Registry ────────────────────────────────────────────────────

export interface SidebarItemDefinition extends ContributedSidebarItem {
  onClick?: () => void;
}

const sidebarItemRegistry = new Map<string, SidebarItemDefinition>();

export function registerSidebarItem(def: SidebarItemDefinition): void {
  sidebarItemRegistry.set(def.id, def);
}

export function getSidebarItem(id: string): SidebarItemDefinition | undefined {
  return sidebarItemRegistry.get(id);
}

export function getRegisteredSidebarItems(): SidebarItemDefinition[] {
  return Array.from(sidebarItemRegistry.values());
}

// ── Top-Level View Registry ──────────────────────────────────────────────────

export interface ViewDefinition extends ContributedView {
  viewId: MainViewType | string;
  component: ComponentType | LazyExoticComponent<ComponentType>;
}

const viewRegistry = new Map<string, ViewDefinition>();

export function registerView(def: ViewDefinition): void {
  viewRegistry.set(def.viewId, def);
}

export function getViewDefinition(id: string): ViewDefinition | undefined {
  return viewRegistry.get(id);
}

export function getRegisteredViews(): ViewDefinition[] {
  return Array.from(viewRegistry.values());
}

// ── Node Action Registry ─────────────────────────────────────────────────────

export interface NodeActionDefinition {
  id: string;
  label: string;
  icon?: string;
  /** Predicate to decide whether the action should appear for a given node. */
  visible?: (nodeId: number) => boolean;
  execute: (nodeId: number) => void;
}

const nodeActionRegistry = new Map<string, NodeActionDefinition>();

export function registerNodeAction(def: NodeActionDefinition): void {
  nodeActionRegistry.set(def.id, def);
}

export function getNodeAction(id: string): NodeActionDefinition | undefined {
  return nodeActionRegistry.get(id);
}

export function getRegisteredNodeActions(): NodeActionDefinition[] {
  return Array.from(nodeActionRegistry.values());
}
