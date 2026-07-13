/**
 * Frontend registries for plugin-contributed extension points.
 *
 * These follow the same module-level Map pattern as the existing command,
 * export-format, and view registries.
 */

import { useSyncExternalStore, type ComponentType, type LazyExoticComponent } from 'react';

import type { MainViewType } from '@/stores/appStore';
import { registerCommand } from '@/stores/commandRegistry';
import { useNavigationStore } from '@/stores';
import type { Node } from '@/types';

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
  execute: (payload: { editor: unknown; blockServerId: string | null }) => void;
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

  // Sidebar items are no longer rendered as buttons; expose them through the
  // command palette so plugin-contributed views remain reachable.
  const commandId = `sidebar.${def.viewId ?? def.id}`;
  registerCommand({
    id: commandId,
    label: `Open ${def.label}`,
    icon: def.icon ? `mdi mdi-${def.icon}` : 'mdi mdi-puzzle-outline',
    context: 'global',
    palette: { category: 'navigation', keywords: [def.label.toLowerCase()] },
    execute: () => {
      if (def.onClick) {
        def.onClick();
      } else if (def.viewId) {
        useNavigationStore.getState().setMainViewType(def.viewId);
      }
    },
  });
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

/**
 * Menu sections a node action can belong to. Both node context menus
 * (page/block menu and inline link/pill menu) render sections in this
 * canonical order with a separator between non-empty sections; `danger`
 * always renders last. Core menu items are mapped onto the same sections,
 * so contributed actions compose with them instead of being appended.
 */
export type NodeMenuGroup = 'main' | 'edit' | 'copy' | 'export' | 'manage' | 'danger';

export const NODE_MENU_GROUP_ORDER: readonly NodeMenuGroup[] = [
  'main',
  'edit',
  'copy',
  'export',
  'manage',
  'danger',
];

/** Default sort order for contributed actions within a section. Core items occupy 0–999. */
export const NODE_ACTION_DEFAULT_ORDER = 1000;

/**
 * Which node context menu an action targets. The trash menu is deliberately
 * excluded — a trashed node is pending deletion and plugin actions are not
 * meaningful there.
 */
export type NodeMenuTarget = 'node' | 'link' | 'archived';

const DEFAULT_NODE_ACTION_MENUS: readonly NodeMenuTarget[] = ['node', 'link'];

/** Context handed to node action `visible`/`execute` callbacks. */
export interface NodeActionContext {
  /** The menu invocation this context belongs to. */
  menu: NodeMenuTarget;
  nodeUuid: string;
  /** Resolved node, or null when the menu could not resolve it (e.g. unresolved link target). */
  node: Node | null;
  /** Close the menu without running further actions. */
  close: () => void;
}

/**
 * A menu item contributed to the node context menus (page/block menu and
 * inline link/pill menu) by the core app or a plugin.
 */
export interface NodeActionDefinition {
  id: string;
  label: string;
  icon?: string;
  /** Scope filter: 'page' = pages only, 'block' = blocks only, 'both' (default) = always shown. */
  scope?: 'page' | 'block' | 'both';
  /** Target menus (default ['node', 'link']). 'node' = page/block menu, 'link' = inline link/pill menu, 'archived' = archived view menu. */
  menus?: NodeMenuTarget[];
  /** Menu section (default 'main'). Sections render in NODE_MENU_GROUP_ORDER. */
  group?: NodeMenuGroup;
  /** Sort order within the section (default NODE_ACTION_DEFAULT_ORDER + registration index). */
  order?: number;
  /** Marks the item as destructive (rendered in danger style). */
  danger?: boolean;
  /** Keyboard shortcut hint shown next to the label. */
  shortcut?: string;
  /** Badge text (e.g. 'DEV'). devOnly actions default to the 'DEV' badge. */
  badge?: string;
  /** If true, the menu stays open after the action executes. */
  keepOpen?: boolean;
  /** Dev action: hidden unless `showDevOptions` is enabled in user settings. */
  devOnly?: boolean;
  /** Predicate to decide whether the action should appear for the given node. */
  visible?: (context: NodeActionContext) => boolean;
  execute: (context: NodeActionContext) => void;
}

const nodeActionRegistry = new Map<string, NodeActionDefinition>();
const nodeActionListeners = new Set<() => void>();
let nodeActionsSnapshot: NodeActionDefinition[] = [];

function notifyNodeActionListeners(): void {
  nodeActionsSnapshot = Array.from(nodeActionRegistry.values());
  nodeActionListeners.forEach((listener) => listener());
}

export function registerNodeAction(def: NodeActionDefinition): void {
  nodeActionRegistry.set(def.id, def);
  notifyNodeActionListeners();
}

export function unregisterNodeAction(id: string): void {
  if (nodeActionRegistry.delete(id)) {
    notifyNodeActionListeners();
  }
}

export function getNodeAction(id: string): NodeActionDefinition | undefined {
  return nodeActionRegistry.get(id);
}

export function getRegisteredNodeActions(): NodeActionDefinition[] {
  return Array.from(nodeActionRegistry.values());
}

/** Subscribe to node action registry changes. Returns an unsubscribe function. */
export function subscribeNodeActions(listener: () => void): () => void {
  nodeActionListeners.add(listener);
  return () => {
    nodeActionListeners.delete(listener);
  };
}

function getNodeActionsSnapshot(): NodeActionDefinition[] {
  return nodeActionsSnapshot;
}

/** React hook: all currently registered node actions (updates on plugin load/unload). */
export function useNodeActions(): NodeActionDefinition[] {
  return useSyncExternalStore(subscribeNodeActions, getNodeActionsSnapshot, getNodeActionsSnapshot);
}

/**
 * Filter registered node actions for a specific menu invocation.
 * `nodeScope: null` means the target node is unresolved — the scope filter
 * passes and the action decides via its `visible` predicate.
 */
export function getVisibleNodeActions(
  actions: NodeActionDefinition[],
  opts: { nodeScope: 'page' | 'block' | null; showDevOptions: boolean; context: NodeActionContext },
): NodeActionDefinition[] {
  return actions.filter((action) => {
    if (action.devOnly && !opts.showDevOptions) return false;
    const targets = action.menus ?? DEFAULT_NODE_ACTION_MENUS;
    if (!targets.includes(opts.context.menu)) return false;
    const scope = action.scope ?? 'both';
    if (opts.nodeScope !== null && scope !== 'both' && scope !== opts.nodeScope) return false;
    if (action.visible && !action.visible(opts.context)) return false;
    return true;
  });
}
