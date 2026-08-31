/**
 * Library plugin frontend setup (notees.library).
 *
 * Registers the top-level Library view, its sidebar rail entry, and an
 * "Open Library" palette command. Everything is registered through the plugin
 * context, so disabling the plugin tears the UI down without a restart.
 */

import type { PluginContext } from '@/plugins/core';
import { useNavigationStore } from '@/stores';
import { LibraryPage } from './LibraryPage';

export function setup(context: PluginContext) {
  context.registerView({
    viewId: 'library',
    id: 'library',
    label: 'Library',
    icon: 'bookshelf',
    component: LibraryPage,
  });

  context.registerSidebarItem({
    id: 'library-sidebar',
    label: 'Library',
    icon: 'bookshelf',
    viewId: 'library',
  });

  context.registerCommand({
    id: 'library.open',
    label: 'Open Library',
    icon: 'mdi mdi-bookshelf',
    context: 'global',
    palette: { category: 'navigation', keywords: ['library', 'sources', 'books'] },
    execute: () => useNavigationStore.getState().setMainViewType('library'),
  });
}
