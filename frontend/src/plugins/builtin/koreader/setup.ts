/**
 * KOReader plugin frontend setup.
 */

import { getLogger } from '@/utils/logger';
import type { PluginContext } from '@/plugins/core';
import { KOReaderHighlightsView } from './components/KOReaderHighlightsView';

const log = getLogger('koreader-plugin');

export function setup(context: PluginContext) {
  context.registerCommand({
    id: 'koreader.sync',
    label: 'KOReader: Sync highlights',
    icon: 'sync',
    context: 'global',
    palette: { category: 'tools' },
    execute: async () => {
      try {
        const api = context.getApiClient();
        await api.post('/sync/koreader.highlights');
      } catch (error) {
        log.error('KOReader sync failed', error);
      }
    },
  });

  context.registerView({
    viewId: 'koreader-highlights',
    id: 'koreader-highlights',
    label: 'KOReader Highlights',
    icon: 'book-open-variant',
    component: KOReaderHighlightsView,
  });
}
