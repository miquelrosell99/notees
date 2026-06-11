/**
 * TabItem — single tab in the tab bar.
 */
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { Tab } from '@/stores/navigationStore';
import { TabContextMenu } from './TabContextMenu';
import type { SplitOrientation } from '@/stores/navigationStore';
import './TabItem.css';

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  isSecondary: boolean;
  canClose: boolean;
  hasSplit: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onDuplicate: () => void;
  onSplit: (orientation: SplitOrientation) => void;
  onUnsplit: () => void;
  onDragStart: (e: React.DragEvent, tabId: string) => void;
  onDragOver: (e: React.DragEvent, tabId: string, index: number) => void;
  onDrop: (e: React.DragEvent, tabId: string, index: number) => void;
  index: number;
}

export function TabItem({
  tab,
  isActive,
  isSecondary,
  canClose,
  hasSplit,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onPin,
  onUnpin,
  onDuplicate,
  onSplit,
  onUnsplit,
  onDragStart,
  onDragOver,
  onDrop,
  index,
}: TabItemProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showClose, setShowClose] = useState(false);
  const tabRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const rect = tabRef.current?.getBoundingClientRect();
    if (rect) {
      setContextMenu({ x: rect.left, y: rect.bottom });
    } else {
      setContextMenu({ x: e.clientX, y: e.clientY });
    }
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      // Middle click to close
      e.preventDefault();
      onClose();
    }
  }, [onClose]);

  return (
    <>
      <div
        ref={tabRef}
        className={`tab-item ${isActive ? 'tab-item--active' : ''} ${isSecondary ? 'tab-item--secondary' : ''} ${tab.pinned ? 'tab-item--pinned' : ''}`}
        onClick={onActivate}
        onContextMenu={handleContextMenu}
        onMouseDown={handleMouseDown}
        onMouseEnter={() => setShowClose(true)}
        onMouseLeave={() => setShowClose(false)}
        draggable
        onDragStart={(e) => onDragStart(e, tab.id)}
        onDragOver={(e) => onDragOver(e, tab.id, index)}
        onDrop={(e) => onDrop(e, tab.id, index)}
        title={tab.label}
        data-tab-id={tab.id}
      >
        {tab.color && (
          <span className="tab-item__color-indicator" style={{ backgroundColor: tab.color }} />
        )}
        {tab.icon && (
          <Icon path={tab.icon} size={0.75} className="tab-item__icon" />
        )}
        {!tab.pinned && (
          <span className="tab-item__label">{tab.label}</span>
        )}
        {canClose && (showClose || isActive) && !tab.pinned && (
          <Button
            variant="ghost"
            size="xs"
            icon="mdi mdi-close"
            className="tab-item__close"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title="Close tab"
          />
        )}
      </div>
      {contextMenu && (
        <TabContextMenu
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          tabId={tab.id}
          isPinned={tab.pinned}
          isActive={isActive}
          canClose={canClose}
          hasSplit={hasSplit}
          history={tab.history}
          historyIndex={tab.historyIndex}
          onCloseTab={onClose}
          onCloseOthers={onCloseOthers}
          onCloseRight={onCloseRight}
          onPin={onPin}
          onUnpin={onUnpin}
          onDuplicate={onDuplicate}
          onSplit={onSplit}
          onUnsplit={onUnsplit}
        />
      )}
    </>
  );
}
