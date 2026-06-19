/**
 * TabOverflowDropdown — dropdown listing all open tabs when they don't fit.
 */
import { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icon } from '@/components/ui';
import { usePopupPosition } from '@/hooks/usePopupPosition';
import type { Tab } from '@/stores/navigationStore';
import './TabOverflowDropdown.css';

interface TabOverflowDropdownProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement | null>;
}

export function TabOverflowDropdown({ tabs, activeTabId, onSelect, onClose, triggerRef }: TabOverflowDropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const popupPosition = usePopupPosition(
    triggerRef,
    panelRef,
    true,
    { alignment: 'right', gap: 8, edgePadding: 8 },
  );

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click; explicit close button provided */}
      <div
        className="tab-overflow-backdrop"
        onClick={onClose}
      />
      {createPortal(
        <div
          ref={panelRef}
          className="tab-overflow-dropdown tab-overflow-dropdown--portal"
          style={
            popupPosition
              ? { position: 'fixed', top: popupPosition.top, left: popupPosition.left }
              : { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }
          }
        >
          <div className="tab-overflow-dropdown__header">
            <span>Open tabs</span>
            <Button
              variant="ghost"
              size="xs"
              icon="mdi mdi-close"
              onClick={onClose}
              aria-label="Close"
            />
          </div>
          <div className="tab-overflow-dropdown__list">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={`tab-overflow-dropdown__item ${tab.id === activeTabId ? 'tab-overflow-dropdown__item--active' : ''} ${tab.pinned ? 'tab-overflow-dropdown__item--pinned' : ''}`}
                onClick={() => {
                  onSelect(tab.id);
                  onClose();
                }}
              >
                {tab.icon && <Icon path={tab.icon} size={0.75} className="tab-overflow-dropdown__icon" />}
                <span className="tab-overflow-dropdown__label">{tab.label}</span>
                {tab.pinned && <Icon path="mdi mdi-pin-outline" size={0.6} className="tab-overflow-dropdown__pin-icon" />}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
