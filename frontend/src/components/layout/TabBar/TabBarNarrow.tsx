/**
 * TabBarNarrow — collapsible tab list for narrow screens.
 */
import { useState, useRef, useCallback } from 'react';
import { useNavigationStore, type Tab } from '@/stores/navigationStore';
import { Icon } from '@/components/core/Icon';
import { Button } from '@/components/core/Button';
import { Card } from '@/components/core/Card';
import { ListSortable } from '@/components/core/ListSortable';

import './TabBarNarrow.css';

interface TabBarNarrowProps {
  tabs: Tab[];
  activeTabId: string;
}

export function TabBarNarrow({ tabs, activeTabId }: TabBarNarrowProps) {
  const [open, setOpen] = useState(false);
  const { activateTab, closeTab, reorderTabs, pinTab, unpinTab } = useNavigationStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const popupRef = useRef<HTMLDivElement>(null);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    reorderTabs(fromIndex, toIndex);
  }, [reorderTabs]);

  return (
    <div className="tab-bar-narrow" ref={popupRef}>
      <Button
        variant="ghost"
        size="sm"
        className="tab-bar-narrow__trigger"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon path="mdi mdi-tab" size={0.8} />
        <span className="tab-bar-narrow__count">{tabs.length}</span>
        {activeTab && (
          <span className="tab-bar-narrow__label">{activeTab.label}</span>
        )}
        <Icon path={open ? 'mdi mdi-chevron-up' : 'mdi mdi-chevron-down'} size={0.7} />
      </Button>

      {open && (
        <Card className="tab-bar-narrow__popup" padding paddingSize="sm" elevation="high">
          <ListSortable
            items={tabs.map((t) => ({ id: t.id, tab: t }))}
            onReorder={handleReorder}
            renderIcon={(item) =>
              item.tab.icon ? <Icon path={item.tab.icon} size={0.75} /> : null
            }
            renderText={(item) => (
              <span className={`tab-bar-narrow__item-label ${item.tab.pinned ? 'tab-bar-narrow__item-label--pinned' : ''}`}>
                {item.tab.label}
                {item.tab.pinned && <Icon path="mdi mdi-pin" size={0.6} />}
              </span>
            )}
            renderActions={(item) => [
              <Button
                key="pin"
                variant="ghost"
                size="xs"
                iconOnly
                icon={item.tab.pinned ? 'mdi mdi-pin-off' : 'mdi mdi-pin'}
                className="tab-bar-narrow__action"
                onClick={(e) => {
                  e.stopPropagation();
                  if (item.tab.pinned) {
                    unpinTab(item.tab.id);
                  } else {
                    pinTab(item.tab.id);
                  }
                }}
                title={item.tab.pinned ? 'Unpin' : 'Pin'}
              />,
              <Button
                key="close"
                variant="ghost"
                size="xs"
                iconOnly
                icon="mdi mdi-close"
                className="tab-bar-narrow__action"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(item.tab.id);
                }}
                title="Close"
              />,
            ]}
            onItemClick={(item) => {
              activateTab(item.tab.id);
              setOpen(false);
            }}
          />
          <div className="tab-bar-narrow__footer">
            <Button
              variant="ghost"
              size="sm"
              icon="mdi mdi-plus"
              onClick={() => {
                // Open a selector — for narrow mode we just open home for now
                // or trigger the same NodeSelector inline
                setOpen(false);
              }}
            >
              New Tab
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
