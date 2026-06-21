/**
 * Flashcards plugin frontend setup.
 */

import type { PluginContext } from '@/plugins/core';
import { FlashcardsPage } from './pages/FlashcardsPage';

export function setup(context: PluginContext) {
  context.registerCommand({
    id: 'flashcards.open',
    label: 'Open Flashcards',
    icon: 'cards-outline',
    context: 'global',
    palette: { category: 'view' },
    execute: () => {
      // Navigation is handled by the sidebar/view registry.
    },
  });

  context.registerView({
    viewId: 'flashcards',
    id: 'flashcards',
    label: 'Flashcards',
    icon: 'cards-outline',
    component: FlashcardsPage,
  });
}
