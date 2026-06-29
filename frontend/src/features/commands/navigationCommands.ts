/**
 * Navigation commands registered for the command palette.
 *
 * These are statically registered at module load time because they only depend
 * on Zustand store actions and API functions.
 */
import { registerCommand, COMMAND_IDS } from '@/stores/commandRegistry';
import { useNavigationStore } from '@/stores';
import { useNotificationStore } from '@/stores/notificationStore';
import { getRandomPages } from '@/api/nodes';
import { buildTasksQueryAST, buildTodayQueryAST } from '@/utils/taskQueries';
import { createEmptyQueryAST } from '@/types/queryAST';
import { SYSTEM_PAGE_UUIDS } from '@/constants/systemProperties';
import type { QueryAST, StyleCondition } from '@/types/queryAST';

registerCommand({
  id: COMMAND_IDS.OPEN_JOURNALS,
  label: 'Open Journals',
  icon: 'mdi mdi-notebook-outline',
  context: 'global',
  palette: { category: 'navigation', keywords: ['journal', 'daily'] },
  execute: () => useNavigationStore.getState().setMainViewType('journals'),
});

registerCommand({
  id: COMMAND_IDS.OPEN_TASKS_VIEW,
  label: 'Open Tasks',
  icon: 'mdi mdi-checkbox-marked-circle-outline',
  context: 'global',
  palette: { category: 'navigation', keywords: ['task', 'todo'] },
  execute: () => useNavigationStore.getState().setMainViewType('tasks'),
});

registerCommand({
  id: COMMAND_IDS.OPEN_ALL_PAGES,
  label: 'Open All Pages',
  icon: 'mdi mdi-book-open-page-variant',
  context: 'global',
  palette: { category: 'navigation', keywords: ['pages', 'all'] },
  execute: () => useNavigationStore.getState().setMainViewType('all-pages'),
});

registerCommand({
  id: COMMAND_IDS.OPEN_PAGES,
  label: 'Open Pages',
  icon: 'mdi mdi-book-open-page-variant',
  context: 'global',
  palette: { category: 'navigation', keywords: ['pages'] },
  execute: () => useNavigationStore.getState().setMainViewType('pages'),
});

registerCommand({
  id: COMMAND_IDS.OPEN_INBOX,
  label: 'Open Inbox',
  icon: 'mdi mdi-inbox-arrow-down',
  context: 'global',
  palette: { category: 'navigation', keywords: ['inbox'] },
  execute: () => useNavigationStore.getState().openNode(SYSTEM_PAGE_UUIDS.inbox),
});

registerCommand({
  id: COMMAND_IDS.OPEN_TEMPLATES,
  label: 'Open Templates',
  icon: 'mdi mdi-file-document-outline',
  context: 'global',
  palette: { category: 'navigation', keywords: ['templates'] },
  execute: () => useNavigationStore.getState().setMainViewType('templates'),
});

registerCommand({
  id: COMMAND_IDS.OPEN_WHITEBOARDS,
  label: 'Open Whiteboards',
  icon: 'mdi mdi-view-dashboard-outline',
  context: 'global',
  palette: { category: 'navigation', keywords: ['whiteboards'] },
  execute: () => useNavigationStore.getState().setMainViewType('whiteboards'),
});

registerCommand({
  id: COMMAND_IDS.OPEN_FLASHCARDS,
  label: 'Open Flashcards',
  icon: 'mdi mdi-cards-outline',
  context: 'global',
  palette: { category: 'navigation', keywords: ['flashcards'] },
  execute: () => useNavigationStore.getState().setMainViewType('flashcards'),
});

registerCommand({
  id: COMMAND_IDS.OPEN_RANDOM_PAGE,
  label: 'Open random page',
  icon: 'mdi mdi-shuffle',
  context: 'global',
  palette: { category: 'navigation' },
  execute: async () => {
    try {
      const pages = await getRandomPages(1);
      if (pages.length > 0) {
        useNavigationStore.getState().openNode(pages[0].uuid);
      } else {
        useNotificationStore.getState().warning('No pages', 'No pages found in workspace.');
      }
    } catch {
      useNotificationStore.getState().error('Failed to open random page', 'Please try again.');
    }
  },
});

registerCommand({
  id: COMMAND_IDS.OPEN_BROKEN_LINKS,
  label: 'Open node list: Broken links',
  icon: 'mdi mdi-link-variant-off',
  context: 'global',
  palette: { category: 'navigation' },
  execute: () => {
    const brokenLinksQuery: QueryAST = {
      ...createEmptyQueryAST(),
      scope: { type: 'scope', scope_type: 'entire_workspace' },
      root_group: {
        type: 'group',
        logic: 'AND',
        children: [
          {
            type: 'condition',
            condition_type: 'style',
            style_type: 'broken_link',
            operator: 'is',
          } as StyleCondition,
        ],
      },
    };
    useNavigationStore.getState().openNodeCollection('Broken links', brokenLinksQuery);
  },
});

registerCommand({
  id: COMMAND_IDS.OPEN_TASKS,
  label: 'Open Tasks',
  icon: 'mdi mdi-format-list-checkbox',
  context: 'global',
  palette: { category: 'navigation', keywords: ['task', 'todo', 'query'] },
  execute: () => {
    useNavigationStore.getState().openNodeCollection('Tasks', buildTasksQueryAST());
  },
});

registerCommand({
  id: COMMAND_IDS.OPEN_TODAY,
  label: 'Open Today',
  icon: 'mdi mdi-calendar-today',
  context: 'global',
  palette: { category: 'navigation', keywords: ['today', 'daily', 'journal'] },
  execute: () => {
    useNavigationStore.getState().openNodeCollection('Today', buildTodayQueryAST());
  },
});

registerCommand({
  id: COMMAND_IDS.CAPTURE_TASK,
  label: 'Capture task',
  icon: 'mdi mdi-plus-circle-outline',
  context: 'global',
  palette: { category: 'navigation', keywords: ['task', 'todo', 'capture'] },
  execute: async () => {
    const notify = useNotificationStore.getState();
    // Capture task needs the page class id and task class id. These are
    // normally provided by hooks, but static registration cannot use hooks.
    // We register the actual implementation in CommandRegistrations.tsx where
    // hooks are available; this static registration provides a fallback that
    // informs the user if something went wrong.
    notify.warning('Setup incomplete', 'Task capture is not available from static context. Please reload the app.');
  },
});
