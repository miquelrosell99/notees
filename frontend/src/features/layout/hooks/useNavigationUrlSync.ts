/**
 * useNavigationUrlSync — keep the browser URL in sync with navigationStore.
 *
 * This replaces the old useUrlSync hook. It watches the store and calls
 * react-router's navigate() instead of manipulating window.history directly.
 *
 * NOTE: This hook must remain synchronous. Starting an async task that
 * captures store values and then calling navigate() after an await creates
 * a stale-closure race: if the store changes while the async task is in
 * flight, the task can push an outdated URL, causing the UI to navigate
 * back to the previous node before the newer task catches up.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { useNavigationStore, type MainViewType } from '@/stores';
import { useShallow } from 'zustand/react/shallow';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { buildUrl } from './url';
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
  } = useNavigationStore(
    useShallow((s) => ({
      mainViewType: s.mainViewType,
      currentNodeUuid: s.currentNodeUuid,
      currentPropertyUuid: s.currentPropertyUuid,
    }))
  );

  const prevStateRef = useRef<{
    mainViewType: MainViewType;
    currentNodeUuid: string | null;
    currentPropertyUuid: string | null;
  } | null>(null);

  useEffect(() => {
    if (isProcessingUrl.current || !hasInitialized.current) return;

    const prevState = prevStateRef.current;
    const stateChanged =
      !prevState ||
      prevState.mainViewType !== mainViewType ||
      prevState.currentNodeUuid !== currentNodeUuid ||
      prevState.currentPropertyUuid !== currentPropertyUuid;

    if (!stateChanged) return;

    prevStateRef.current = {
      mainViewType,
      currentNodeUuid,
      currentPropertyUuid,
    };

    const baseParams = {
      viewType: mainViewType,
      workspaceUuid: workspaceId ?? null,
    };

    let url: string;
    if (mainViewType === 'property' && currentPropertyUuid) {
      url = buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: currentPropertyUuid });
    } else if (mainViewType === 'node' && currentNodeUuid) {
      url = buildUrl({ ...baseParams, nodeUuid: currentNodeUuid, propertyUuid: null });
    } else {
      url = buildUrl({ ...baseParams, nodeUuid: null, propertyUuid: null });
    }

    const currentUrl = location.pathname + location.search;

    if (url !== currentUrl) {
      log.debug('Pushing URL from store', { from: currentUrl, to: url });
      useNavigationHistoryStore.getState().push();
      navigate(url);
    }
  }, [
    mainViewType,
    currentNodeUuid,
    currentPropertyUuid,
    workspaceId,
    location.pathname,
    location.search,
    navigate,
    isProcessingUrl,
    hasInitialized,
  ]);
}
