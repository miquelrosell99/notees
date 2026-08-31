/**
 * PluginContext tests: the view-platform teardown contract.
 *
 * Everything registered through a plugin's context must be removed by
 * unregisterAll() — that is what makes restartless enable/disable clean for
 * view, sidebar, command, slash-command, and NodeCollection-view
 * contributions.
 */
import { describe, it, expect } from 'vitest';

import { useCommandRegistry } from '@/stores/commandRegistry';
import { getViewDefinition as getNodeCollectionView } from '@/features/views/components/registry';
import { getPropertyValueRenderer } from '@/features/properties/utils/propertyValueRegistry';
import { createPluginContext } from './PluginContext';
import type { PluginManifest } from './manifest';
import {
  getSidebarItem,
  getSlashCommand,
  getViewDefinition,
} from './registries';
import { viewPrimitives } from './primitives';

const DummyComponent = () => null;

function manifest(): PluginManifest {
  return {
    id: 'notees.context-test',
    name: 'Context Test',
    version: '1.0.0',
  };
}

describe('PluginContext', () => {
  it('exposes the documented view primitives', () => {
    const context = createPluginContext(manifest());
    expect(context.primitives).toBe(viewPrimitives);
    expect(context.primitives.QueryNodeCollection).toBeDefined();
    expect(context.primitives.NodeSelector).toBeDefined();
    expect(context.primitives.PropertiesSection).toBeDefined();
    expect(context.primitives.PageViewHeader).toBeDefined();
    expect(context.primitives.NodeCollection).toBeDefined();
  });

  it('unregisterAll removes every contribution kind', () => {
    const context = createPluginContext(manifest());

    context.registerView({ viewId: 'ctx.view', id: 'ctx.view', label: 'Ctx', component: DummyComponent });
    context.registerSidebarItem({ id: 'ctx.sidebar', label: 'Ctx', viewId: 'ctx.view' });
    context.registerCommand({ id: 'ctx.command', label: 'Ctx', context: 'global', execute: () => {} });
    context.registerSlashCommand({ id: 'ctx.slash', label: 'Ctx', execute: () => {} });
    context.registerNodeCollectionView({
      id: 'ctx-mode',
      label: 'Ctx mode',
      icon: 'mdi mdi-test-tube',
      component: DummyComponent,
      capabilities: {},
    });
    context.registerPropertyRenderer({
      type: 'ctx-type',
      label: 'Ctx',
      icon: 'test-tube',
      component: DummyComponent,
      getDefaultValue: () => null,
      formatValue: () => '',
      getGroupInfo: () => ({ label: '', icon: null }),
      compareValues: () => 0,
    });

    expect(getViewDefinition('ctx.view')).toBeDefined();
    expect(getSidebarItem('ctx.sidebar')).toBeDefined();
    expect(useCommandRegistry.getState().getCommand('ctx.command')).toBeDefined();
    // Sidebar items auto-register a palette companion command.
    expect(useCommandRegistry.getState().getCommand('sidebar.ctx.view')).toBeDefined();
    expect(getSlashCommand('ctx.slash')).toBeDefined();
    expect(getNodeCollectionView('ctx-mode')).toBeDefined();
    expect(getPropertyValueRenderer('ctx-type')).toBeDefined();

    context.unregisterAll();

    expect(getViewDefinition('ctx.view')).toBeUndefined();
    expect(getSidebarItem('ctx.sidebar')).toBeUndefined();
    expect(useCommandRegistry.getState().getCommand('ctx.command')).toBeUndefined();
    expect(useCommandRegistry.getState().getCommand('sidebar.ctx.view')).toBeUndefined();
    expect(getSlashCommand('ctx.slash')).toBeUndefined();
    expect(getNodeCollectionView('ctx-mode')).toBeUndefined();
    expect(getPropertyValueRenderer('ctx-type')).toBeUndefined();
  });
});
