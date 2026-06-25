/**
 * Main content area component
 *
 * Renders the active tab (or split pane with two tabs).
 */
import { useMemo, useEffect, useRef } from 'react';
import { useTabState, useOpenNode } from '@/features/layout/hooks/useNavigationSelectors';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/features/content';
import { MainContentPane } from './MainContentPane';
import { SplitPane } from './SplitPane';

export function MainContent() {
  const { tabs, activeTabId, secondaryTabId, splitOrientation } = useTabState();
  const openNode = useOpenNode();
  const queryClient = useQueryClient();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const secondaryTab = tabs.find((t) => t.id === secondaryTabId);
  const prevViewRef = useRef(activeTab?.type);

  // Cancel in-flight per-node queries when navigating away from a view.
  useEffect(() => {
    const prevView = prevViewRef.current;
    prevViewRef.current = activeTab?.type;
    if (prevView !== activeTab?.type && prevView === 'journals') {
      queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      queryClient.cancelQueries({ queryKey: nodeKeys.allLinkedRefs() });
      queryClient.cancelQueries({ queryKey: nodeKeys.allPropertyBacklinks() });
      queryClient.cancelQueries({ queryKey: nodeViewKeys.lists() });
      queryClient.cancelQueries({ queryKey: nodeViewKeys.queryResults() });
    }
  }, [activeTab?.type, queryClient]);

  const handleNavigate = useMemo(() => (nodeId: string | number) => {
    openNode(nodeId);
  }, [openNode]);

  if (!activeTab) {
    return (
      <div className="main-content">
        <div className="empty-state">
          <h2>Welcome to Notees</h2>
          <p>Select a page from the sidebar, or press Ctrl+K to create one.</p>
        </div>
      </div>
    );
  }

  if (secondaryTab && splitOrientation) {
    return (
      <SplitPane
        orientation={splitOrientation}
        primary={<MainContentPane tab={activeTab} onNavigateToNode={handleNavigate} />}
        secondary={<MainContentPane tab={secondaryTab} onNavigateToNode={handleNavigate} />}
      />
    );
  }

  return <MainContentPane tab={activeTab} onNavigateToNode={handleNavigate} />;
}
