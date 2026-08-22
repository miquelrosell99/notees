/**
 * Page-specific commands registered for the command palette.
 *
 * These commands require an active page node and/or React Query cache access.
 * The cache-aware implementations are registered in CommandRegistrations.tsx;
 * the static registrations here expose the commands to the palette and provide
 * safe no-op fallbacks.
 */
import { registerCommand, COMMAND_IDS } from '@/stores/commandRegistry';
import { useNavigationStore } from '@/stores';
import { useModalStore } from '@/stores/modalStore';

registerCommand({
  id: COMMAND_IDS.EXPORT_PAGE,
  label: 'Export current page',
  icon: 'mdi mdi-export',
  context: 'global',
  requiresPage: true,
  capability: 'importExport',
  palette: { category: 'page' },
  execute: () => {
    const currentId = useNavigationStore.getState().currentNodeUuid;
    if (currentId) {
      useModalStore.getState().setExportPageModalOpen(true);
    }
  },
});

registerCommand({
  id: COMMAND_IDS.SHARE_PAGE,
  label: 'Share current page',
  icon: 'mdi mdi-share-variant-outline',
  context: 'global',
  requiresPage: true,
  capability: 'shares',
  palette: { category: 'page' },
  execute: () => {
    const currentId = useNavigationStore.getState().currentNodeUuid;
    if (currentId) {
      useModalStore.getState().setShareModalOpen(true);
    }
  },
});

registerCommand({
  id: COMMAND_IDS.TOGGLE_PRIVATE,
  label: 'Toggle page privacy',
  icon: 'mdi mdi-lock-outline',
  context: 'global',
  requiresPage: true,
  palette: { category: 'page' },
  execute: () => {
    // The actual implementation needs queryClient + updateNode mutation; it is
    // registered dynamically in CommandRegistrations.tsx. This static entry
    // keeps the command visible in the palette.
  },
});

registerCommand({
  id: COMMAND_IDS.RESET_VIEWS,
  label: 'Reset views to defaults (current node)',
  icon: 'mdi mdi-database-refresh',
  context: 'global',
  requiresPage: true,
  devOnly: true,
  palette: { category: 'page' },
  execute: () => {
    // Cache-aware implementation registered in CommandRegistrations.tsx.
  },
});

registerCommand({
  id: COMMAND_IDS.MERGE_PAGES,
  label: 'Merge pages',
  icon: 'mdi mdi-merge',
  context: 'global',
  palette: { category: 'page' },
  execute: () => {
    useModalStore.getState().setMergePagesModalOpen(true);
  },
});
