/**
 * TabBarNormal — horizontal scrollable tab strip for desktop.
 *
 * Uses a SelectionButton-like container with a sliding indicator
 * for the active tab. Supports drag-and-drop reordering, dropping
 * nodes onto tabs, mouse-wheel tab switching, pinned tabs, and
 * overflow dropdown.
 */
import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { useNavigationStore, type Tab, type SplitOrientation } from '@/stores/navigationStore';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/Button';
import { NodeSelector } from '@/features/content';
import { TabOverflowDropdown } from './TabOverflowDropdown';
import type { Node } from '@/types';
import { TabItem } from './TabItem';
import './TabBarNormal.css';

interface TabBarNormalProps {
  tabs: Tab[];
  activeTabId: string | null;
  secondaryTabId: string | null;
  splitOrientation: SplitOrientation | null;
}

export function TabBarNormal({ tabs, activeTabId, secondaryTabId, splitOrientation }: TabBarNormalProps) {
  const viewMode = useNavigationStore((s) => s.viewMode);
  const isFocusMode = viewMode === 'focus';
  const {
    activateTab,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    pinTab,
    unpinTab,
    reorderTabs,
    openNodeInNewTab,
    replaceTabContent,
    splitTab,
    unsplit,
  } = useNavigationStore(
    useShallow((s) => ({
      activateTab: s.activateTab,
      closeTab: s.closeTab,
      closeOtherTabs: s.closeOtherTabs,
      closeTabsToRight: s.closeTabsToRight,
      pinTab: s.pinTab,
      unpinTab: s.unpinTab,
      reorderTabs: s.reorderTabs,
      openNodeInNewTab: s.openNodeInNewTab,
      replaceTabContent: s.replaceTabContent,
      splitTab: s.splitTab,
      unsplit: s.unsplit,
    }))
  );

  const stripRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const [showPicker, setShowPicker] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const hasSplit = !!splitOrientation;
  const tabsKey = tabs.map((t) => t.id).join(',');

  const pinnedTabs = useMemo(() => tabs.filter((t) => t.pinned), [tabs]);
  const unpinnedTabs = useMemo(() => tabs.filter((t) => !t.pinned), [tabs]);

  // Detect overflow
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const check = () => {
      setShowOverflow(strip.scrollWidth > strip.clientWidth + 1);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [tabsKey]);

  // Auto-scroll to keep the active tab visible
  useEffect(() => {
    const strip = stripRef.current;
    const activeTab = strip?.querySelector('.tab-item--active') as HTMLElement | null;
    if (!strip || !activeTab) return;

    const tabLeft = activeTab.offsetLeft;
    const tabRight = tabLeft + activeTab.offsetWidth;
    const scrollLeft = strip.scrollLeft;
    const visibleWidth = strip.clientWidth;

    if (tabLeft < scrollLeft) {
      strip.scrollTo({ left: tabLeft, behavior: 'smooth' });
    } else if (tabRight > scrollLeft + visibleWidth) {
      strip.scrollTo({ left: tabRight - visibleWidth, behavior: 'smooth' });
    }
  }, [activeTabId]);

  // Mouse wheel to switch tabs
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (tabs.length <= 1) return;
      if (!activeTabId) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
      if (currentIndex === -1) return;
      const delta = e.deltaY > 0 ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(tabs.length - 1, currentIndex + delta));
      if (nextIndex !== currentIndex) {
        activateTab(tabs[nextIndex].id);
      }
    },
    [tabs, activeTabId, activateTab]
  );

  const handleDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    e.dataTransfer.setData('application/x-notees-tab', tabId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, _tabId: string, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const hasNode = e.dataTransfer.types.includes('application/x-notees-node');
    const hasTab = e.dataTransfer.types.includes('application/x-notees-tab');

    if (hasNode) {
      setDragOverIndex(null);
      return;
    }

    if (hasTab) {
      setDragOverIndex(index);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, tabId: string, index: number) => {
      e.preventDefault();
      setDragOverIndex(null);

      const draggedTabId = e.dataTransfer.getData('application/x-notees-tab');
      const nodeData = e.dataTransfer.getData('application/x-notees-node');

      if (draggedTabId) {
        const fromIndex = tabs.findIndex((t) => t.id === draggedTabId);
        if (fromIndex >= 0 && fromIndex !== index) {
          reorderTabs(fromIndex, index);
        }
        return;
      }

      if (nodeData) {
        try {
          const nodeInfo = JSON.parse(nodeData) as { nodeId?: number; nodeUuid?: string };
          const targetId = nodeInfo?.nodeUuid ?? nodeInfo?.nodeId;
          if (targetId) {
            replaceTabContent(tabId, targetId);
          }
        } catch {
          // ignore
        }
        return;
      }
    },
    [tabs, reorderTabs, replaceTabContent]
  );

  const handleStripDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOverIndex(null);

      const nodeData = e.dataTransfer.getData('application/x-notees-node');
      if (!nodeData) return;

      try {
        const nodeInfo = JSON.parse(nodeData) as { nodeId?: number; nodeUuid?: string };
        const targetId = nodeInfo?.nodeUuid ?? nodeInfo?.nodeId;
        if (targetId) {
          openNodeInNewTab(targetId);
        }
      } catch {
        // ignore
      }
    },
    [openNodeInNewTab]
  );

  const handleStripDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('application/x-notees-node')) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDuplicate = useCallback(
    (tab: Tab) => {
      openNodeInNewTab(tab.nodeUuid ?? 0, {
        label: tab.label,
        icon: tab.icon,
        color: tab.color,
      });
    },
    [openNodeInNewTab]
  );

  const handleSelectNode = useCallback(
    (node: Node) => {
      openNodeInNewTab(node.uuid, { label: node.display_name || node.name });
      setShowPicker(false);
    },
    [openNodeInNewTab]
  );

  const renderTabItem = useCallback(
    (tab: Tab, index: number) => (
      <div key={tab.id} className="tab-bar-normal__slot">
        {dragOverIndex === index && <div className="tab-bar-normal__insert-indicator" />}
        <TabItem
          tab={tab}
          isActive={tab.id === activeTabId}
          isSecondary={tab.id === secondaryTabId}
          canClose={tabs.length > 1 || (!tab.pinned && tabs.length > 0)}
          hasSplit={hasSplit}
          onActivate={() => activateTab(tab.id)}
          onClose={() => closeTab(tab.id)}
          onCloseOthers={() => closeOtherTabs(tab.id)}
          onCloseRight={() => closeTabsToRight(tab.id)}
          onPin={() => pinTab(tab.id)}
          onUnpin={() => unpinTab(tab.id)}
          onDuplicate={() => handleDuplicate(tab)}
          onSplit={(orientation) => splitTab(tab.id, orientation)}
          onUnsplit={unsplit}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          index={index}
        />
      </div>
    ),
    [
      dragOverIndex,
      activeTabId,
      secondaryTabId,
      tabs.length,
      hasSplit,
      activateTab,
      closeTab,
      closeOtherTabs,
      closeTabsToRight,
      pinTab,
      unpinTab,
      handleDuplicate,
      splitTab,
      unsplit,
      handleDragStart,
      handleDragOver,
      handleDrop,
    ]
  );

  return (
    <div className="tab-bar-normal" data-focus-mode={isFocusMode || undefined}>
      <div
        className="tab-bar-normal__strip"
        ref={stripRef}
        onDrop={handleStripDrop}
        onDragOver={handleStripDragOver}
        onWheel={handleWheel}
      >
        {pinnedTabs.length > 0 && (
          <div className="tab-bar-normal__pinned">
            {pinnedTabs.map((tab, i) => renderTabItem(tab, i))}
          </div>
        )}

        {unpinnedTabs.map((tab, i) => renderTabItem(tab, pinnedTabs.length + i))}
        {dragOverIndex === tabs.length && <div className="tab-bar-normal__insert-indicator" />}

        {tabs.length > 0 && <div className="tab-bar-normal__section-divider" />}

        <Button aria-label="New tab"
          ref={addBtnRef}
          icon="mdi mdi-plus"
          variant="ghost"
          size="xs"
          className="tab-bar-normal__add-btn"
          onClick={() => setShowPicker((v) => !v)}
          title="New tab"
        />
        {showPicker && addBtnRef.current && (
          <NodeSelector
            anchorEl={addBtnRef.current}
            onClose={() => setShowPicker(false)}
            onAdd={handleSelectNode}
            searchPlaceholder="Search for a page to open..."
          />
        )}

      </div>

      {showOverflow && (
        <div className="tab-bar-normal__overflow">
          <Button aria-label="All tabs"
            ref={overflowBtnRef}
            icon="mdi mdi-chevron-down"
            variant="ghost"
            size="sm"
            className="tab-bar-normal__overflow-btn"
            onClick={() => setOverflowOpen((v) => !v)}
            title="All tabs"
          />
          {overflowOpen && (
            <TabOverflowDropdown
              tabs={tabs}
              activeTabId={activeTabId}
              onSelect={activateTab}
              onClose={() => setOverflowOpen(false)}
              triggerRef={overflowBtnRef}
            />
          )}
        </div>
      )}
    </div>
  );
}
