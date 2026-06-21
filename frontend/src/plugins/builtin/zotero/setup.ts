/**
 * Zotero plugin frontend setup.
 */

import { getLogger } from '@/utils/logger';
import type { PluginContext } from '@/plugins/core';
import { ZoteroLibraryView } from './components/ZoteroLibraryView';

const log = getLogger('zotero-plugin');

export function setup(context: PluginContext) {
  context.registerCommand({
    id: 'zotero.sync',
    label: 'Zotero: Sync now',
    icon: 'sync',
    context: 'global',
    palette: { category: 'tools' },
    execute: async () => {
      try {
        const api = context.getApiClient();
        await api.post('/sync/zotero.library');
      } catch (error) {
        log.error('Zotero sync failed', error);
      }
    },
  });

  context.registerView({
    viewId: 'zotero-library',
    id: 'zotero-library',
    label: 'Zotero Library',
    icon: 'bookshelf',
    component: ZoteroLibraryView,
  });
}
