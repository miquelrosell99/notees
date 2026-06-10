/**
 * TabContextMenu — context menu for individual tabs.
 */
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import type { SplitOrientation } from '@/stores/navigationStore';

interface TabContextMenuProps {
  position: { x: number; y: number };
  onClose: () => void;
  tabId: string;
  isPinned: boolean;
  isActive: boolean;
  canClose: boolean;
  hasSplit: boolean;
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
  isPinned,
  hasSplit,
  canClose,
  onCloseTab,
  onCloseOthers,
  onCloseRight,
  onPin,
  onUnpin,
  onDuplicate,
  onSplit,
  onUnsplit,
}: TabContextMenuProps) {
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

  return <ContextMenu items={items} position={position} onClose={onClose} alignRight />;
}
