/**
 * useDocumentTitle — sync the browser tab title with the current view.
 *
 * Format: "Notees - {Node/View Name}"
 * Falls back to "Notees" when no meaningful label is available.
 */
import { useEffect } from 'react';
import { useNavigationStore } from '@/stores/navigationStore';

const DEFAULT_TITLE = 'Notees';

const VIEW_LABELS: Record<string, string> = {
  node: 'Node',
  pages: 'Pages',
  'all-pages': 'All Pages',
  journals: 'Journals',
  graph: 'Graph',
  timeline: 'Timeline',
  archived: 'Archived',
  trash: 'Trash',
  assets: 'Assets',
  property: 'Property',
  'node-collection': 'Collection',
  shares: 'Shares',
  inbox: 'Inbox',
  whiteboards: 'Whiteboards',
  templates: 'Templates',
  flashcards: 'Flashcards',
};

export function useDocumentTitle() {
  const mainViewType = useNavigationStore((s) => s.mainViewType);
  const currentNodeUuid = useNavigationStore((s) => s.currentNodeUuid);
  const currentPropertyUuid = useNavigationStore((s) => s.currentPropertyUuid);

  useEffect(() => {
    let label = VIEW_LABELS[mainViewType];
    if (mainViewType === 'node' && currentNodeUuid) {
      label = 'Node';
    } else if (mainViewType === 'property' && currentPropertyUuid) {
      label = 'Property';
    }

    if (label && label !== DEFAULT_TITLE) {
      document.title = `${DEFAULT_TITLE} - ${label}`;
    } else {
      document.title = DEFAULT_TITLE;
    }
  }, [mainViewType, currentNodeUuid, currentPropertyUuid]);
}
