/**
 * View / UI commands registered for the command palette.
 */
import { registerCommand, COMMAND_IDS } from '@/stores/commandRegistry';
import { useNavigationStore, useSettingsStore, usePresentationStore } from '@/stores';
import { useModalStore } from '@/stores/modalStore';

registerCommand({
  id: COMMAND_IDS.TOGGLE_FOCUS_MODE,
  label: 'Toggle Focus Mode',
  icon: 'mdi mdi-brain',
  context: 'global',
  palette: { category: 'view' },
  execute: () => useNavigationStore.getState().toggleFocusMode(),
});

registerCommand({
  id: COMMAND_IDS.TOGGLE_WIDE_MODE,
  label: 'Toggle wide mode',
  icon: 'mdi mdi-arrow-expand-horizontal',
  context: 'global',
  palette: { category: 'view' },
  execute: () => useSettingsStore.getState().toggleWideMode(),
});

registerCommand({
  id: COMMAND_IDS.TOGGLE_MINIMAP,
  label: 'Toggle minimap',
  icon: 'mdi mdi-map',
  context: 'global',
  palette: { category: 'view' },
  execute: () => useModalStore.getState().toggleMinimap(),
});

registerCommand({
  id: COMMAND_IDS.TOGGLE_LOCAL_GRAPH,
  label: 'Toggle local graph',
  icon: 'mdi mdi-graph-outline',
  context: 'global',
  requiresPage: true,
  palette: { category: 'view' },
  execute: () => {
    const currentId = useNavigationStore.getState().currentNodeId;
    if (currentId) {
      useNavigationStore.getState().openLocalGraph(currentId);
    }
  },
});

registerCommand({
  id: COMMAND_IDS.START_PRESENTATION,
  label: 'Start presentation',
  icon: 'mdi mdi-presentation-play',
  context: 'global',
  requiresPage: true,
  palette: { category: 'view' },
  execute: () => {
    const currentId = useNavigationStore.getState().currentNodeId;
    if (currentId) {
      usePresentationStore.getState().openPresentation(currentId);
    }
  },
});
