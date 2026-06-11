import { useEffect, useRef, type MutableRefObject } from 'react';
import { useNavigationStore } from '@/stores';
import { getNode } from '@/api/nodes';
import { pushUrl } from '@/hooks/useRouter';
import { getLogger } from '@/utils/logger';

const log = getLogger('RouterSync');

export function useUrlSync(
  hasInitialized: MutableRefObject<boolean>,
  isProcessingUrl: MutableRefObject<boolean>,
) {
  const {
    mainViewType,
    currentNodeId,
    currentPropertyId,
    tabs,
    activeTabId,
    secondaryTabId,
    splitOrientation,
  } = useNavigationStore();

  const prevStateRef = useRef<{
    mainViewType: typeof mainViewType;
    currentNodeId: number | null;
    currentPropertyId: number | null;
    activeTabId: string | null;
    secondaryTabId: string | null;
    splitOrientation: string | null;
  } | null>(null);

  useEffect(() => {
    if (isProcessingUrl.current) return;
    if (!hasInitialized.current) return;

    const prevState = prevStateRef.current;
    const stateChanged = !prevState ||
      prevState.mainViewType !== mainViewType ||
      prevState.currentNodeId !== currentNodeId ||
      prevState.currentPropertyId !== currentPropertyId ||
      prevState.activeTabId !== activeTabId ||
      prevState.secondaryTabId !== secondaryTabId ||
      prevState.splitOrientation !== (splitOrientation ?? null);

    if (!stateChanged) return;

    prevStateRef.current = {
      mainViewType,
      currentNodeId,
      currentPropertyId,
      activeTabId: activeTabId ?? null,
      secondaryTabId: secondaryTabId ?? null,
      splitOrientation: splitOrientation ?? null,
    };

    const updateUrlAsync = async () => {
      let splitUuid: string | undefined;
      const splitOrient = splitOrientation;
      const secondaryTab = tabs.find((t) => t.id === secondaryTabId);
      if (secondaryTab && splitOrient) {
        if (secondaryTab.nodeId) {
          try {
            const node = await getNode(secondaryTab.nodeId);
            splitUuid = node.uuid;
          } catch { /* ignore */ }
        } else if (secondaryTab.propertyId) {
          try {
            const { getProperty } = await import('@/api/properties');
            const property = await getProperty(secondaryTab.propertyId);
            splitUuid = property.uuid;
          } catch { /* ignore */ }
        }
      }

      if (mainViewType === 'property' && currentPropertyId) {
        try {
          const { getProperty } = await import('@/api/properties');
          const property = await getProperty(currentPropertyId);
          pushUrl({
            viewType: 'property',
            nodeUuid: null,
            propertyUuid: property.uuid,
            splitUuid,
            splitOrientation: splitOrient,
          });
        } catch (err) {
          log.error('Failed to get property UUID for URL', err);
        }
        return;
      }

      if (mainViewType !== 'node' && mainViewType !== 'property') {
        pushUrl({
          viewType: mainViewType,
          nodeUuid: null,
          propertyUuid: null,
          splitUuid,
          splitOrientation: splitOrient,
        });
        return;
      }

      if (mainViewType === 'node' && currentNodeId) {
        try {
          const node = await getNode(currentNodeId);
          pushUrl({
            viewType: 'node',
            nodeUuid: node.uuid,
            propertyUuid: null,
            splitUuid,
            splitOrientation: splitOrient,
          });
        } catch (err) {
          log.error('Failed to get node UUID for URL', err);
        }
      } else {
        pushUrl({
          viewType: 'node',
          nodeUuid: null,
          propertyUuid: null,
          splitUuid,
          splitOrientation: splitOrient,
        });
      }
    };

    updateUrlAsync();
  }, [mainViewType, currentNodeId, currentPropertyId, tabs, activeTabId, secondaryTabId, splitOrientation]);
}
