/**
 * TabOverflowDropdown — dropdown listing all open tabs when they don't fit.
 */
import { useRef, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { Tab } from '@/stores/navigationStore';
import './TabOverflowDropdown.css';

interface TabOverflowDropdownProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: () => void;
}

export function TabOverflowDropdown({ tabs, activeTabId, onSelect, onClose }: TabOverflowDropdownProps) {
  const panelRef = useRef<HTMLDivElement>(null);

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
      <div ref={panelRef} className="tab-overflow-dropdown">
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
      </div>
    </>
  );
}
