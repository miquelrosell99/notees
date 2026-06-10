/**
 * TabBarNormal — horizontal scrollable tab strip for desktop.
 */
import { useCallback, useRef, useState, useEffect } from 'react';
import { useNavigationStore, type Tab, type SplitOrientation } from '@/stores/navigationStore';
import { TabItem } from './TabItem';
import { NewTabButton } from './NewTabButton';
import './TabBarNormal.css';

interface TabBarNormalProps {
  tabs: Tab[];
  activeTabId: string;
  secondaryTabId: string | null;
  splitOrientation: SplitOrientation | null;
}

export function TabBarNormal({ tabs, activeTabId, secondaryTabId, splitOrientation }: TabBarNormalProps) {
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
  } = useNavigationStore();

  const stripRef = useRef<HTMLDivElement>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const hasSplit = !!splitOrientation;

  // Update tab labels/icons/colors when nodes load
  useEffect(() => {
    // This will be handled by the parent TabBar component via useNode queries
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    e.dataTransfer.setData('application/x-notees-tab', tabId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, _tabId: string, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Check if we're dragging a node from outside
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



  const handleDrop = useCallback((e: React.DragEvent, tabId: string, index: number) => {
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
        const nodeInfo = JSON.parse(nodeData) as { nodeId?: number };
        if (nodeInfo?.nodeId) {
          // Drop ON a tab → replace that tab's content
          replaceTabContent(tabId, nodeInfo.nodeId);
        }
      } catch {
        // ignore
      }
      return;
    }
  }, [tabs, reorderTabs, replaceTabContent]);

  const handleStripDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIndex(null);

    const nodeData = e.dataTransfer.getData('application/x-notees-node');
    if (!nodeData) return;

    try {
      const nodeInfo = JSON.parse(nodeData) as { nodeId?: number };
      if (nodeInfo?.nodeId) {
        // Drop BETWEEN tabs → add new tab at end
        openNodeInNewTab(nodeInfo.nodeId);
      }
    } catch {
      // ignore
    }
  }, [openNodeInNewTab]);

  const handleStripDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('application/x-notees-node')) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const handleDuplicate = useCallback((tab: Tab) => {
    openNodeInNewTab(tab.nodeId ?? 0, {
      label: tab.label,
      icon: tab.icon,
      color: tab.color,
    });
  }, [openNodeInNewTab]);

  return (
    <div className="tab-bar-normal" ref={stripRef} onDrop={handleStripDrop} onDragOver={handleStripDragOver}>
      <div className="tab-bar-normal__strip">
        {tabs.map((tab, index) => (
          <div key={tab.id} className="tab-bar-normal__slot">
            {dragOverIndex === index && (
              <div className="tab-bar-normal__insert-indicator" />
            )}
            <TabItem
              tab={tab}
              isActive={tab.id === activeTabId}
              isSecondary={tab.id === secondaryTabId}
              canClose={tabs.length > 1 || !tab.pinned}
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
        ))}
        {dragOverIndex === tabs.length && (
          <div className="tab-bar-normal__insert-indicator" />
        )}
      </div>
      <NewTabButton onSelectNode={(node) => openNodeInNewTab(node.id, { label: node.display_name || node.name })} />
    </div>
  );
}
