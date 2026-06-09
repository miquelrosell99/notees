/**
 * useDocumentTitle — sync the browser tab title with the active tab label.
 *
 * Format: "Notees - {Active Tab Label}"
 * Falls back to "Notees" when no meaningful label is available.
 */
import { useEffect } from 'react';
import { useNavigationStore } from '@/stores/navigationStore';

const DEFAULT_TITLE = 'Notees';

export function useDocumentTitle() {
  const tabs = useNavigationStore((s) => s.tabs);
  const activeTabId = useNavigationStore((s) => s.activeTabId);

  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const label = activeTab?.label?.trim();

    if (label && label !== DEFAULT_TITLE) {
      document.title = `${DEFAULT_TITLE} - ${label}`;
    } else {
      document.title = DEFAULT_TITLE;
    }
  }, [tabs, activeTabId]);
}
