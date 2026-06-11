/**
 * TabContextMenu — context menu for individual tabs.
 */
import { useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { useNavigationStore, type SplitOrientation, type TabHistoryEntry } from '@/stores/navigationStore';

const HISTORY_PAGE_SIZE = 10;

interface TabContextMenuProps {
  position: { x: number; y: number };
  onClose: () => void;
  tabId: string;
  isPinned: boolean;
  isActive: boolean;
  canClose: boolean;
  hasSplit: boolean;
  history: TabHistoryEntry[];
  historyIndex: number;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onDuplicate: () => void;
  onSplit: (orientation: SplitOrientation) => void;
  onUnsplit: () => void;
}

export function TabContextMenu({
  position,
  onClose,
  tabId,
  isPinned,
  hasSplit,
  canClose,
  history,
  historyIndex,
  onCloseTab,
  onCloseOthers,
  onCloseRight,
  onPin,
  onUnpin,
  onDuplicate,
  onSplit,
  onUnsplit,
}: TabContextMenuProps) {
  const navigateToHistoryEntry = useNavigationStore((s) => s.navigateToHistoryEntry);
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(HISTORY_PAGE_SIZE);

  const visibleHistory = history.slice(0, visibleHistoryCount);
  const hasMoreHistory = history.length > visibleHistoryCount;

  const items: ContextMenuItem[] = [
    {
      id: 'close',
      label: 'Close',
      icon: 'mdi mdi-close',
      disabled: !canClose,
      onClick: onCloseTab,
    },
    {
      id: 'close-others',
      label: 'Close Others',
      icon: 'mdi mdi-close-box-outline',
      onClick: onCloseOthers,
    },
    {
      id: 'close-right',
      label: 'Close All to the Right',
      icon: 'mdi mdi-close-box-multiple-outline',
      onClick: onCloseRight,
    },
    { id: 'sep1', label: '', separator: true },
    {
      id: 'pin',
      label: isPinned ? 'Unpin Tab' : 'Pin Tab',
      icon: isPinned ? 'mdi mdi-pin-off-outline' : 'mdi mdi-pin-outline',
      onClick: isPinned ? onUnpin : onPin,
    },
    {
      id: 'duplicate',
      label: 'Duplicate Tab',
      icon: 'mdi mdi-content-duplicate',
      onClick: onDuplicate,
    },
    { id: 'sep2', label: '', separator: true },
    {
      id: 'split-h',
      label: 'Split Right',
      icon: 'mdi mdi-arrow-split-vertical',
      disabled: hasSplit,
      onClick: () => onSplit('horizontal'),
    },
    {
      id: 'split-v',
      label: 'Split Down',
      icon: 'mdi mdi-arrow-split-horizontal',
      disabled: hasSplit,
      onClick: () => onSplit('vertical'),
    },
  ];

  if (hasSplit) {
    items.push({
      id: 'unsplit',
      label: 'Unsplit',
      icon: 'mdi mdi-window-restore',
      onClick: onUnsplit,
    });
  }

  if (history.length > 0) {
    items.push({ id: 'sep3', label: '', separator: true });
    items.push({ id: 'history-label', label: `History (${history.length})`, disabled: true });
    visibleHistory.forEach((entry, i) => {
      items.push({
        id: `history-${i}`,
        label: entry.label,
        icon: i === historyIndex ? 'mdi mdi-check' : undefined,
        onClick: () => {
          navigateToHistoryEntry(tabId, i);
          onClose();
        },
      });
    });
    if (hasMoreHistory) {
      const remaining = history.length - visibleHistoryCount;
      items.push({
        id: 'history-load-more',
        label: `Load more (${remaining} remaining)`,
        icon: 'mdi mdi-chevron-down',
        keepOpen: true,
        onClick: () => setVisibleHistoryCount((c) => c + HISTORY_PAGE_SIZE),
      });
    }
  }

  return <ContextMenu items={items} position={position} onClose={onClose} alignRight />;
}
