/**
 * Developer-only commands registered for the command palette.
 */
import { registerCommand, COMMAND_IDS } from '@/stores/commandRegistry';
import { useModalStore } from '@/stores/modalStore';

registerCommand({
  id: COMMAND_IDS.FIX_RAW_LINKS,
  label: 'Fix raw UUID links',
  icon: 'mdi mdi-link-variant',
  context: 'global',
  devOnly: true,
  palette: { category: 'developer' },
  execute: () => useModalStore.getState().setFixRawLinksModalOpen(true),
});

registerCommand({
  id: COMMAND_IDS.CREATE_PAGE_WITH_UUID,
  label: 'Create node with custom UUID',
  icon: 'mdi mdi-fingerprint',
  context: 'global',
  devOnly: true,
  palette: { category: 'developer' },
  execute: () => useModalStore.getState().setCreateWithUuidModalOpen(true),
});
