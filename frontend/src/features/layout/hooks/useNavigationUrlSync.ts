/**
 * useNavigationUrlSync — keep the browser URL in sync with navigationStore.
 *
 * This replaces the old useUrlSync hook. It watches the store and calls
 * react-router's navigate() instead of manipulating window.history directly.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useNavigationStore, type MainViewType } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
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
    currentNodeUuid,
    currentPropertyUuid,
    tabs,
    activeTabId,
    secondaryTabId,
    splitOrientation,
  } = useNavigationStore(
    useShallow((s) => ({
      mainViewType: s.mainViewType,
      currentNodeUuid: s.currentNodeUuid,
      currentPropertyUuid: s.currentPropertyUuid,
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      secondaryTabId: s.secondaryTabId,
      splitOrientation: s.splitOrientation,
    }))
  );

  const prevStateRef = useRef<{
    mainViewType: MainViewType;
    currentNodeUuid: string | null;
    currentPropertyUuid: string | null;
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
      prevState.currentNodeUuid !== currentNodeUuid ||
      prevState.currentPropertyUuid !== currentPropertyUuid ||
      prevState.activeTabId !== activeTabId ||
      prevState.secondaryTabId !== secondaryTabId ||
      prevState.splitOrientation !== splitOrientation;

    if (!stateChanged) return;

    prevStateRef.current = {
      mainViewType,
      currentNodeUuid,
      currentPropertyUuid,
      activeTabId: activeTabId ?? null,
      secondaryTabId: secondaryTabId ?? null,
      splitOrientation: splitOrientation ?? null,
    };

    const updateUrlAsync = async () => {
      let splitUuid: string | undefined;
      const splitOrient = splitOrientation;
      const secondaryTab = tabs.find((t) => t.id === secondaryTabId);

      if (secondaryTab && splitOrient) {
        if (secondaryTab.nodeUuid) {
          try {
            const node = await getNode(secondaryTab.nodeUuid);
            splitUuid = node.uuid;
          } catch {
            /* ignore */
          }
        } else if (secondaryTab.propertyUuid) {
          try {
            const { getProperty } = await import('@/api/properties');
            const property = await getProperty(secondaryTab.propertyUuid);
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
        if (mainViewType === 'property' && currentPropertyUuid) {
          try {
            const { getProperty } = await import('@/api/properties');
            const property = await getProperty(currentPropertyUuid);
            return buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: property.uuid });
          } catch (err) {
            log.error('Failed to get property UUID for URL', err);
            return buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: null });
          }
        }

        if (mainViewType !== 'node' && mainViewType !== 'property') {
          return buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: null });
        }

        if (mainViewType === 'node' && currentNodeUuid) {
          try {
            const node = await getNode(currentNodeUuid);
            return buildUrl({ ...baseParams, nodeUuid: node.uuid, propertyUuid: null });
          } catch (err) {
            log.error('Failed to get node UUID for URL', err);
          }
          return buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: null });
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
    currentNodeUuid,
    currentPropertyUuid,
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
