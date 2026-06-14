/**
 * Import / export / maintenance commands registered for the command palette.
 */
import { registerCommand, COMMAND_IDS } from '@/stores/commandRegistry';
import { useModalStore } from '@/stores/modalStore';

registerCommand({
  id: COMMAND_IDS.IMPORT_LOGSEQ,
  label: 'Import Logseq',
  icon: 'mdi mdi-database-import',
  context: 'global',
  palette: { category: 'import-export' },
  execute: () => useModalStore.getState().setImportLogseqModalOpen(true),
});

registerCommand({
  id: COMMAND_IDS.IMPORT_LOGSEQ_FOLDER,
  label: 'Import Logseq Markdown folder',
  icon: 'mdi mdi-folder-open',
  context: 'global',
  palette: { category: 'import-export' },
  execute: () => useModalStore.getState().setImportLogseqFolderModalOpen(true),
});

registerCommand({
  id: COMMAND_IDS.IMPORT_MARKDOWN,
  label: 'Import Markdown files',
  icon: 'mdi mdi-language-markdown',
  context: 'global',
  palette: { category: 'import-export' },
  execute: () => useModalStore.getState().setImportMarkdownModalOpen(true),
});

registerCommand({
  id: COMMAND_IDS.REBUILD_LINKS,
  label: 'Rebuild links from AST',
  icon: 'mdi mdi-refresh',
  context: 'global',
  palette: { category: 'import-export' },
  execute: () => useModalStore.getState().setRebuildLinksModalOpen(true),
});

registerCommand({
  id: COMMAND_IDS.FORCE_REEXPORT,
  label: 'Force re-export all pages to markdown',
  icon: 'mdi mdi-sync',
  context: 'global',
  devOnly: true,
  palette: { category: 'import-export' },
  execute: () => useModalStore.getState().setAutoExportProgressModalOpen(true),
});
