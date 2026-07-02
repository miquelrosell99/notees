/**
 * Main content area component
 *
 * Renders the current main view directly from navigationStore.
 */
import { useMemo, useEffect, useRef } from 'react';
import { useNavigationStore } from '@/stores';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { nodeViewKeys } from '@/features/content';
import { MainContentPane } from './MainContentPane';

export function MainContent() {
  const mainViewType = useNavigationStore((s) => s.mainViewType);
  const currentNodeUuid = useNavigationStore((s) => s.currentNodeUuid);
  const currentPropertyUuid = useNavigationStore((s) => s.currentPropertyUuid);
  const nodeCollectionTitle = useNavigationStore((s) => s.nodeCollectionTitle);
  const openNode = useNavigationStore((s) => s.openNode);
  const queryClient = useQueryClient();
  const prevViewRef = useRef(mainViewType);

  // Cancel in-flight per-node queries when navigating away from a view.
  useEffect(() => {
    const prevView = prevViewRef.current;
    prevViewRef.current = mainViewType;
    if (prevView !== mainViewType && prevView === 'journals') {
      queryClient.cancelQueries({ queryKey: nodeKeys.details() });
      queryClient.cancelQueries({ queryKey: nodeKeys.allLinkedRefs() });
      queryClient.cancelQueries({ queryKey: nodeKeys.allPropertyBacklinks() });
      queryClient.cancelQueries({ queryKey: nodeViewKeys.lists() });
      queryClient.cancelQueries({ queryKey: nodeViewKeys.queryResults() });
    }
  }, [mainViewType, queryClient]);

  const handleNavigate = useMemo(() => (nodeUuid: string) => {
    openNode(nodeUuid);
  }, [openNode]);

  return (
    <MainContentPane
      viewType={mainViewType}
      nodeUuid={currentNodeUuid ?? undefined}
      propertyUuid={currentPropertyUuid ?? undefined}
      nodeCollectionTitle={nodeCollectionTitle}
      onNavigateToNode={handleNavigate}
    />
  );
}
