/**
 * TabBar — container that dispatches between normal (desktop) and narrow (mobile) tab bars.
 *
 * Also responsible for fetching node display data for tab labels/icons/colors.
 */
import { useMemo, useEffect } from 'react';
import { useNavigationStore } from '@/stores/navigationStore';
import { useIsMobile } from '@/hooks';
import { useSettingsStore } from '@/stores';
import { TabBarNormal } from './TabBarNormal';
import { TabBarNarrow } from './TabBarNarrow';
import { TabBarVertical } from './TabBarVertical';
import { useNodesDisplayData } from './useTabNodeData';
import './TabBar.css';

export function TabBar() {
  const isMobile = useIsMobile();
  const tabPosition = useSettingsStore((s) => s.tabPosition);
  const tabs = useNavigationStore((s) => s.tabs);
  const activeTabId = useNavigationStore((s) => s.activeTabId);
  const secondaryTabId = useNavigationStore((s) => s.secondaryTabId);
  const splitOrientation = useNavigationStore((s) => s.splitOrientation);
  const updateTabLabel = useNavigationStore((s) => s.updateTabLabel);

  // Fetch display data for tabs that have node UUIDs
  const nodeUuids = useMemo(() => tabs.map((t) => t.nodeUuid).filter((id): id is string => typeof id === 'string'), [tabs]);
  const displayData = useNodesDisplayData(nodeUuids);

  // Sync tab labels/icons/colors from fetched node data
  useEffect(() => {
    for (const tab of tabs) {
      if (!tab.nodeUuid) continue;
      const data = displayData[tab.nodeUuid];
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

  if (tabPosition === 'left') {
    return (
      <TabBarVertical
        tabs={tabs}
        activeTabId={activeTabId}
        secondaryTabId={secondaryTabId}
        splitOrientation={splitOrientation}
      />
    );
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
