/**
 * useNavigationUrlSync — keep the browser URL in sync with navigationStore.
 *
 * This replaces the old useUrlSync hook. It watches the store and calls
 * react-router's navigate() instead of manipulating window.history directly.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useNavigationStore, type MainViewType } from '@/stores';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { buildUrl } from './url';
import { getNode } from '@/api/nodes';
import { getLogger } from '@/utils/logger';

const log = getLogger('NavigationUrlSync');

interface NavigationUrlSyncRefs {
  hasInitialized: MutableRefObject<boolean>;
  isProcessingUrl: MutableRefObject<boolean>;
}

export function useNavigationUrlSync({ hasInitialized, isProcessingUrl }: NavigationUrlSyncRefs) {
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceId } = useParams<{ workspaceId?: string }>();

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
    mainViewType: MainViewType;
    currentNodeId: number | null;
    currentPropertyId: number | null;
    activeTabId: string | null;
    secondaryTabId: string | null;
    splitOrientation: 'horizontal' | 'vertical' | null;
  } | null>(null);

  useEffect(() => {
    if (isProcessingUrl.current || !hasInitialized.current) return;

    const prevState = prevStateRef.current;
    const stateChanged =
      !prevState ||
      prevState.mainViewType !== mainViewType ||
      prevState.currentNodeId !== currentNodeId ||
      prevState.currentPropertyId !== currentPropertyId ||
      prevState.activeTabId !== activeTabId ||
      prevState.secondaryTabId !== secondaryTabId ||
      prevState.splitOrientation !== splitOrientation;

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
          } catch {
            /* ignore */
          }
        } else if (secondaryTab.propertyId) {
          try {
            const { getProperty } = await import('@/api/properties');
            const property = await getProperty(secondaryTab.propertyId);
            splitUuid = property.uuid;
          } catch {
            /* ignore */
          }
        }
      }

      const baseParams = {
        viewType: mainViewType,
        workspaceUuid: workspaceId ?? null,
        splitUuid: splitUuid ?? null,
        splitOrientation: splitOrient ?? null,
      };

      const build = async (): Promise<string> => {
        if (mainViewType === 'property' && currentPropertyId) {
          try {
            const { getProperty } = await import('@/api/properties');
            const property = await getProperty(currentPropertyId);
            return buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: property.uuid });
          } catch (err) {
            log.error('Failed to get property UUID for URL', err);
            return buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: null });
          }
        }

        if (mainViewType !== 'node' && mainViewType !== 'property') {
          return buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: null });
        }

        if (mainViewType === 'node' && currentNodeId) {
          try {
            const node = await getNode(currentNodeId);
            return buildUrl({ ...baseParams, nodeUuid: node.uuid, propertyUuid: null });
          } catch (err) {
            log.error('Failed to get node UUID for URL', err);
            return buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: null });
          }
        }

        return buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: null });
      };

      const url = await build();
      const currentUrl = location.pathname + location.search;

      if (url !== currentUrl) {
        log.debug('Pushing URL from store', { from: currentUrl, to: url });
        useNavigationHistoryStore.getState().push();
        navigate(url);
      }
    };

    updateUrlAsync();
  }, [
    mainViewType,
    currentNodeId,
    currentPropertyId,
    tabs,
    activeTabId,
    secondaryTabId,
    splitOrientation,
    workspaceId,
    location.pathname,
    location.search,
    navigate,
    isProcessingUrl,
    hasInitialized,
  ]);
}
