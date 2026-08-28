/**
 * Tests for the view/sidebar/slash-command registry lifecycle added for the
 * plugin view platform: registration, clean unregistration (plugin toggle
 * teardown), subscriptions, and the palette companion command of sidebar
 * items.
 */
import { describe, it, expect, vi } from 'vitest';

import { useCommandRegistry } from '@/stores/commandRegistry';
import {
  getRegisteredSidebarItems,
  getRegisteredSlashCommands,
  getRegisteredViews,
  getSidebarItem,
  getSlashCommand,
  getViewDefinition,
  registerSidebarItem,
  registerSlashCommand,
  registerView,
  subscribeSidebarItems,
  subscribeViews,
  unregisterSidebarItem,
  unregisterSlashCommand,
  unregisterView,
} from './registries';

const DummyComponent = () => null;

describe('viewRegistry lifecycle', () => {
  it('registers and unregisters top-level views', () => {
    registerView({ viewId: 'test.view', id: 'test.view', label: 'Test View', component: DummyComponent });
    expect(getViewDefinition('test.view')?.label).toBe('Test View');
    expect(getRegisteredViews().map((v) => v.viewId)).toContain('test.view');

    unregisterView('test.view');
    expect(getViewDefinition('test.view')).toBeUndefined();
    expect(getRegisteredViews().map((v) => v.viewId)).not.toContain('test.view');
  });

  it('notifies subscribers on register/unregister', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeViews(listener);

    registerView({ viewId: 'test.sub', id: 'test.sub', label: 'Sub', component: DummyComponent });
    unregisterView('test.sub');
    unsubscribe();
    registerView({ viewId: 'test.sub2', id: 'test.sub2', label: 'Sub2', component: DummyComponent });
    unregisterView('test.sub2');

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unregistering an unknown view is a no-op', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeViews(listener);
    unregisterView('test.nonexistent');
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('sidebarItemRegistry lifecycle', () => {
  it('registers items with a palette companion command and cleans both up', () => {
    registerSidebarItem({ id: 'test.item', label: 'Test Item', icon: 'puzzle-outline', viewId: 'test.view' });

    expect(getSidebarItem('test.item')?.viewId).toBe('test.view');
    expect(getRegisteredSidebarItems().map((i) => i.id)).toContain('test.item');
    expect(useCommandRegistry.getState().commands.get('sidebar.test.view')).toBeDefined();

    unregisterSidebarItem('test.item');

    expect(getSidebarItem('test.item')).toBeUndefined();
    expect(getRegisteredSidebarItems().map((i) => i.id)).not.toContain('test.item');
    expect(useCommandRegistry.getState().commands.get('sidebar.test.view')).toBeUndefined();
  });

  it('notifies subscribers on register/unregister', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarItems(listener);

    registerSidebarItem({ id: 'test.side', label: 'Side', viewId: 'test.side-view' });
    unregisterSidebarItem('test.side');
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unregistering an unknown item is a no-op', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSidebarItems(listener);
    unregisterSidebarItem('test.nonexistent');
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('slashCommandRegistry lifecycle', () => {
  it('registers and unregisters slash commands', () => {
    registerSlashCommand({ id: 'test.slash', label: 'Test Slash', execute: () => {} });
    expect(getSlashCommand('test.slash')?.label).toBe('Test Slash');
    expect(getRegisteredSlashCommands().map((c) => c.id)).toContain('test.slash');

    unregisterSlashCommand('test.slash');
    expect(getSlashCommand('test.slash')).toBeUndefined();
    expect(getRegisteredSlashCommands().map((c) => c.id)).not.toContain('test.slash');
  });
});
