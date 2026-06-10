/**
 * TabBar — container that dispatches between normal (desktop) and narrow (mobile) tab bars.
 *
 * Also responsible for fetching node display data for tab labels/icons/colors.
 */
import { useMemo, useEffect } from 'react';
import { useNavigationStore } from '@/stores/navigationStore';
import { useIsMobile } from '@/hooks';
import { TabBarNormal } from './TabBarNormal';
import { TabBarNarrow } from './TabBarNarrow';
import { useNodesDisplayData } from './useTabNodeData';
import './TabBar.css';

export function TabBar() {
  const isMobile = useIsMobile();
  const tabs = useNavigationStore((s) => s.tabs);
  const activeTabId = useNavigationStore((s) => s.activeTabId);
  const secondaryTabId = useNavigationStore((s) => s.secondaryTabId);
  const splitOrientation = useNavigationStore((s) => s.splitOrientation);
  const updateTabLabel = useNavigationStore((s) => s.updateTabLabel);

  // Fetch display data for tabs that have nodeIds
  const nodeIds = useMemo(() => tabs.map((t) => t.nodeId).filter((id): id is number => !!id), [tabs]);
  const displayData = useNodesDisplayData(nodeIds);

  // Sync tab labels/icons/colors from fetched node data
  useEffect(() => {
    for (const tab of tabs) {
      if (!tab.nodeId) continue;
      const data = displayData[tab.nodeId];
      if (!data) continue;
      const label = data.displayText || tab.label;
      const icon = data.effectiveIcon || tab.icon;
      const color = data.color || tab.color;
      if (label !== tab.label || icon !== tab.icon || color !== tab.color) {
        updateTabLabel(tab.id, label, icon ?? undefined, color ?? undefined);
      }
    }
  }, [tabs, displayData, updateTabLabel]);

  if (isMobile) {
    return <TabBarNarrow tabs={tabs} activeTabId={activeTabId} />;
  }

  return (
    <TabBarNormal
      tabs={tabs}
      activeTabId={activeTabId}
      secondaryTabId={secondaryTabId}
      splitOrientation={splitOrientation}
    />
  );
}
