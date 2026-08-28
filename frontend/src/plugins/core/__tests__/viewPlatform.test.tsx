/**
 * View-platform test: a minimal third-party-style plugin can register a
 * custom view composed only of the exposed primitives, the view renders, and
 * unregisterAll (plugin disable) removes it cleanly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createElement, type ComponentType } from 'react';

import { createPluginContext } from '../PluginContext';
import { getSidebarItem, getViewDefinition } from '../registries';
import { viewPrimitives } from '../primitives';
import type { PluginManifest } from '../manifest';
import {
  FIXTURE_DASHBOARD_TITLE,
  FIXTURE_VIEW_ID,
  setup as fixtureSetup,
} from './fixtures/classDashboardPlugin';

const fixtureManifest: PluginManifest = {
  id: 'thirdparty.books-dashboard',
  name: 'Books Dashboard',
  version: '1.0.0',
};

describe('plugin view platform (third-party-style fixture)', () => {
  afterEach(() => {
    cleanup();
  });

  it('registers a custom view and sidebar entry built from exposed primitives', () => {
    const context = createPluginContext(fixtureManifest);
    fixtureSetup(context);

    const view = getViewDefinition(FIXTURE_VIEW_ID);
    expect(view).toBeDefined();
    expect(view?.label).toBe('Books Dashboard');
    expect(getSidebarItem('fixture-books-sidebar')?.viewId).toBe(FIXTURE_VIEW_ID);

    // The registered view renders using only primitive components.
    const Component = view!.component as ComponentType;
    render(createElement(Component));
    expect(screen.getByText(FIXTURE_DASHBOARD_TITLE)).toBeTruthy();
    expect(screen.getByTestId('fixture-picker-available').dataset.hasPicker).toBe('true');

    // Teardown (plugin disable) removes the view and sidebar entry.
    context.unregisterAll();
    expect(getViewDefinition(FIXTURE_VIEW_ID)).toBeUndefined();
    expect(getSidebarItem('fixture-books-sidebar')).toBeUndefined();
  });

  it('exposes QueryNodeCollection as a composable primitive', () => {
    // The fixture's dashboard body is a QueryNodeCollection over a
    // class-filtered AST; here we only assert the primitive is the real
    // app component (mounting it needs the full workspace store).
    expect(viewPrimitives.QueryNodeCollection.name).toBe('QueryNodeCollection');
  });
});
