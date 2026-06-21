/**
 * Logseq importer plugin frontend setup.
 */

import { useModalStore } from '@/stores/modalStore';
import type { PluginContext } from '@/plugins/core';

export function setup(context: PluginContext) {
  context.registerCommand({
    id: 'logseq.importFolder',
    label: 'Import Logseq folder',
    icon: 'folder-open',
    context: 'global',
    palette: { category: 'import-export' },
    execute: () => {
      useModalStore.getState().setImportLogseqFolderModalOpen(true);
    },
  });
}
