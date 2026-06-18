/**
 * TabItem — single tab in the tab bar.
 */
import { useCallback, useRef, useState } from 'react';
import { Button, Icon } from '@/components/ui';
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
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const tabRef = useRef<HTMLButtonElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuOpen(true);
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
      <div className={`tab-item-wrapper ${canClose && !tab.pinned ? 'tab-item-wrapper--closeable' : ''}`}>
        <button
          ref={tabRef}
          type="button"
          role="tab"
          aria-selected={isActive}
          className={`tab-item ${isActive ? 'tab-item--active' : ''} ${isSecondary ? 'tab-item--secondary' : ''} ${tab.pinned ? 'tab-item--pinned' : ''} ${canClose && !tab.pinned ? 'tab-item--closeable' : ''}`}
          onClick={onActivate}
          onContextMenu={handleContextMenu}
          onMouseDown={handleMouseDown}
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
        </button>
        {canClose && !tab.pinned && (
          <Button aria-label="Close tab"
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
      {contextMenuOpen && (
        <TabContextMenu
          anchorEl={tabRef.current}
          onClose={() => setContextMenuOpen(false)}
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
