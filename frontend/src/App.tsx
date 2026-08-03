/**
 * Main application component
 *
 * Architecture:
 * - BrowserRouter / Routes: react-router-dom routing
 * - QueryClientProvider: TanStack Query for server state
 * - KeyboardShortcutsProvider: Centralized keyboard shortcut handling
 * - ErrorBoundary: Graceful error recovery
 * - NotificationToast: Global notification display
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import {
  queryClient,
  workspaceAwarePersister,
  setPersistWorkspaceUuid,
  invalidateWorkspaceQueries,
} from './lib/queryClient';
import { NotificationToast, type ToastNotification } from './components/ui/NotificationToast';
import { useNotificationStore, type Notification } from './stores/notificationStore';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { KeyboardShortcutsProvider } from './hooks/KeyboardShortcutsProvider';
import { useGlobalKeyboardListener } from './hooks/useGlobalKeyboardListener';
import { useDisableNativeContextMenu } from './hooks/useDisableNativeContextMenu';
import { useWindowFocusActiveBlock } from './hooks/useWindowFocusActiveBlock';
import { useCommand } from './hooks/useCommand';
import { useUndoStackPersistence, AppRoutes } from '@/features/layout';
import { CommandRegistrations } from './features/commands';
import { COMMAND_IDS } from './stores/commandRegistry';
import { DndProvider } from './providers/DndProvider';
import { useUndoStore, useAuthStore } from './stores';
import { useInputContext } from './stores/inputContext';
import { useBackendHealth } from './hooks/useBackendHealth';
import { useBackgroundSync } from './hooks/useBackgroundSync';
import { useWorkspaces } from '@/features/workspace';
import { BackendUnavailableOverlay } from './components/ui/BackendUnavailableOverlay';
import { getLogger } from './utils/logger';
import { pluginManager } from '@/plugins/core';
import { WorkspaceStoreProvider } from '@/core/hooks/WorkspaceStoreProvider';
import {
  ensureSqlInitialized,
  getSqlInitError,
  clearSqlInitError,
} from '@/core/db/connection';
import { requestPersistentStorage } from '@/core/persistence/storagePersistence';
import { createHttpTransport } from '@/core/transportHttp';
import {
  getOrCreateWorkspaceStore,
  getWorkspaceSyncEngine,
  closeWorkspaceStore,
} from '@/core/adapters/workspaceStoreAdapter';
import { Button } from '@/components/ui/Button';
import { registerVisibilitySync } from '@/core/serviceWorker/syncOnVisibility';
import {
  useSyncStatusStore,
  DEFAULT_PROGRESS,
  SyncConflictListener,
} from '@/features/sync';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { SyncProgressModal } from '@/components/ui/SyncProgressModal';
import './App.css';

const log = getLogger('App');

function isOriginWherePersistenceWarningMakesSense(): boolean {
  if (typeof window === 'undefined') return false;
  const { protocol, hostname } = window.location;
  return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * Global keyboard listener component
 * Sets up the centralized keyboard event handler
 */
function AuthSyncListener() {
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      // Another tab logged out or cleared persisted auth state.
      if (
        event.key === 'auth:logout' ||
        (event.key === 'auth-storage' && event.newValue === null)
      ) {
        if (user) {
          logout();
        }
      }
    }

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [logout, user]);

  return null;
}

function GlobalKeyboardHandler() {
  useGlobalKeyboardListener();
  useDisableNativeContextMenu();
  useUndoStackPersistence();
  useWindowFocusActiveBlock();

  // Register global commands in the Command Registry
  useCommand(COMMAND_IDS.UNDO, () => {
    useUndoStore.getState().performUndo(queryClient);
  }, { label: 'Undo' });

  useCommand(COMMAND_IDS.REDO, () => {
    useUndoStore.getState().performRedo(queryClient);
  }, { label: 'Redo' });

  useCommand(COMMAND_IDS.REDO_ALT, () => {
    useUndoStore.getState().performRedo(queryClient);
  }, { label: 'Redo' });

  useCommand(COMMAND_IDS.ESCAPE, () => {
    return useInputContext.getState().closeTopSurface();
  }, { label: 'Close top overlay' });

  return null;
}

function AppContent() {
  // Start the backend health poller. It runs for the lifetime of the app.
  useBackendHealth();
  // Register web background sync (Periodic Background Sync + one-shot sync).
  useBackgroundSync();
  return <AppRoutes />;
}

function toToastNotification(n: Notification): ToastNotification {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    dismissible: n.dismissible,
    action: n.action,
  };
}

function ConnectedNotificationToast() {
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);
  return (
    <NotificationToast
      notifications={notifications.map(toToastNotification)}
      onDismiss={removeNotification}
    />
  );
}

// Module-level guard to prevent double-initialization under React StrictMode
let appInitialized = false;

function App() {
  const authVerified = useAuthStore((s) => s.authVerified);

  useEffect(() => {
    if (appInitialized) return;
    appInitialized = true;
    log.info('Notees application initialized', {
      version: import.meta.env.VITE_APP_VERSION || 'dev',
      mode: import.meta.env.MODE,
    });

    // Request persistent storage so IndexedDB is less likely to be evicted
    // under storage pressure. Only warn on HTTPS/localhost; over plain HTTP
    // the browser is expected to deny the request, so the warning is noise.
    requestPersistentStorage()
      .then((granted) => {
        log.info('Persistent storage request result', { granted });
        if (!granted && isOriginWherePersistenceWarningMakesSense()) {
          useNotificationStore.getState().warning(
            'Storage may be cleared automatically',
            'Your browser denied persistent storage. Notees data could be evicted if disk space runs low. Consider allowing storage persistence in your browser settings.'
          );
        }
      })
      .catch((err) => {
        log.warn('Failed to request persistent storage', err);
      });

    // Eagerly initialize sql.js so wasm/persistence failures surface early.
    ensureSqlInitialized().catch((err) => {
      const sqlError = getSqlInitError();
      log.error('sql.js initialization failed', err);
      useNotificationStore.getState().error(
        'Database engine failed to load',
        sqlError?.message ?? 'SQLite could not start. Some offline features may not work until you refresh the page.'
      );
    });
  }, []);

  // Load frontend plugins once the session is verified. Built-in plugins are
  // bundled; user plugins are fetched from the backend and imported dynamically.
  // Loading before authentication would hit the protected /plugins endpoint and
  // trigger a failing token refresh on every unauthenticated visit.
  useEffect(() => {
    if (!authVerified) return;
    pluginManager.loadPlugins().catch((err) => {
      log.error('Failed to load plugins', err);
    });
  }, [authVerified]);

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <EncryptedPersistProvider>
        <AppProviders>
          <WorkspaceStoreInitializer>
            <BrowserRouter>
              <ErrorBoundary context="App">
                <AppContent />
              </ErrorBoundary>
            </BrowserRouter>
          </WorkspaceStoreInitializer>
          <ConnectedNotificationToast />
        </AppProviders>
      </EncryptedPersistProvider>
      <BackendUnavailableOverlay />
    </>
  );
}

const PERSIST_OPTIONS = {
  maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  dehydrateOptions: {
    shouldDehydrateQuery: (query: { queryKey: unknown; state: { status: string } }) => {
      const queryKey = query.queryKey as string[];
      if (!queryKey || queryKey.length === 0) return false;
      // Exclude pending queries: promises cannot be serialised, so
      // restoring them causes "dehydrated as pending ended up rejecting"
      // warnings on the next hydration.
      if (query.state.status === 'pending') return false;
      // Exclude auth-related queries
      if (queryKey[0] === 'auth') return false;

      // Exclude heavy, fast-moving node query families that contain
      // large trees and change frequently during normal editing.
      // Persisting them causes multi-megabyte IndexedDB writes that
      // block the main thread (see performance remediation plan).
      if (queryKey[0] === 'nodes') {
        const heavyNodeKeys = new Set([
          'detail',
          'page-content',
          'uuid',
          'backlinks',
          'linked-refs',
          'search',
          'graph',
          'graph-nodes',
          'graph-links',
          'daily',
          'monthly',
          'yearly',
          'children-only',
          'batch-get',
          'batch-properties',
          'gantt-day-nodes',
          'pages',
          'list',
        ]);
        if (heavyNodeKeys.has(queryKey[1])) return false;
      }

      // Exclude large dynamic query-result sets (tables, cards, etc.)
      if (queryKey[0] === 'nodeViews' && queryKey[1] === 'queryResults') {
        return false;
      }

      return true;
    },
    // Never persist mutations. Pending mutations contain Promise objects
    // that cannot be safely serialised; restoring them causes
    // "promise.then is not a function" errors during hydration.
    shouldDehydrateMutation: () => false,
  },
};

/**
 * Keeps the workspace-aware persister in sync with the active workspace.
 *
 * This must render *inside* PersistQueryClientProvider because it uses
 * `useWorkspaces`, which in turn uses TanStack Query's useQuery hook.
 */
function WorkspacePersisterSync() {
  const user = useAuthStore((s) => s.user);
  const authVerified = useAuthStore((s) => s.authVerified);
  const { data: workspacesData } = useWorkspaces({ enabled: !!user && authVerified });
  const activeWorkspace = useMemo(() => {
    if (!workspacesData?.items) return null;
    return workspacesData.items.find((ws) => ws.is_active) ?? null;
  }, [workspacesData]);
  const workspaceUuid = activeWorkspace?.uuid ?? null;

  useEffect(() => {
    setPersistWorkspaceUuid(workspaceUuid);
    // Invalidate workspace-scoped queries when the active workspace changes so
    // cached data from one workspace is never displayed under another, while
    // keeping auth/settings/workspace-list caches intact.
    invalidateWorkspaceQueries(queryClient);
  }, [workspaceUuid]);

  return null;
}

function EncryptedPersistProvider({ children }: { children: React.ReactNode }) {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ ...PERSIST_OPTIONS, persister: workspaceAwarePersister }}>
      <WorkspacePersisterSync />
      {children}
    </PersistQueryClientProvider>
  );
}

/**
 * Initialize the local-first workspace store for the active workspace and
 * provide it (plus the transport) to the rest of the app.
 *
 * While a workspace is being opened, this component renders a fullscreen
 * loading overlay *instead of* its children. That prevents the main UI from
 * mounting underneath the overlay and freezing while the local database is
 * opened and the first sync runs.
 */
function WorkspaceStoreInitializer({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const authVerified = useAuthStore((s) => s.authVerified);
  const actorId = user?.uuid ?? 'anonymous';
  const {
    data: workspacesData,
    isLoading: isLoadingWorkspaces,
    isError: isWorkspacesError,
    error: workspacesError,
    refetch: refetchWorkspaces,
  } = useWorkspaces({ enabled: !!user && authVerified });
  const activeWorkspace = useMemo(() => {
    if (!workspacesData?.items) return null;
    return workspacesData.items.find((ws) => ws.is_active) ?? null;
  }, [workspacesData]);
  const workspaceId = activeWorkspace?.uuid ?? null;
  const [showWorkspaceTimeout, setShowWorkspaceTimeout] = useState(false);

  useEffect(() => {
    if (!isLoadingWorkspaces) {
      setShowWorkspaceTimeout(false);
      return;
    }
    const id = setTimeout(() => setShowWorkspaceTimeout(true), 10000);
    return () => clearTimeout(id);
  }, [isLoadingWorkspaces, workspaceId]);
  const [ctx, setCtx] = useState<
    { actorId: string; transport: ReturnType<typeof createHttpTransport> } | undefined
  >();
  const [readyWorkspaceId, setReadyWorkspaceId] = useState<string | null>(null);
  const [initError, setInitError] = useState<Error | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [phaseMessage, setPhaseMessage] = useState<string>('Loading workspaces…');
  const unregisterVisibilityRef = useRef<(() => void) | null>(null);
  const isInitializing = useSyncStatusStore((s) =>
    workspaceId ? s.getWorkspaceProgress(workspaceId).isInitializing : DEFAULT_PROGRESS.isInitializing
  );
  const pullProgress = useSyncStatusStore((s) =>
    workspaceId ? s.getWorkspaceProgress(workspaceId).pullProgress : DEFAULT_PROGRESS.pullProgress
  );
  const forceResyncWorkspaceId = useSyncStatusStore((s) => s.forceResyncWorkspaceId);
  const forceResyncPullProgress = useSyncStatusStore((s) =>
    forceResyncWorkspaceId
      ? s.getWorkspaceProgress(forceResyncWorkspaceId).pullProgress
      : DEFAULT_PROGRESS.pullProgress
  );
  const workspaceResetNonce = useSyncStatusStore((s) => s.workspaceResetNonce);

  // Diagnostic logging: if the workspace init effect re-runs, this tells us which
  // dependency changed. Spurious dependency changes are the usual cause of the
  // blank-reload symptom during sync.
  const prevDepsRef = useRef({ workspaceId, actorId, workspaceResetNonce, retryNonce, authVerified });
  useEffect(() => {
    const prev = prevDepsRef.current;
    const changes: string[] = [];
    if (prev.workspaceId !== workspaceId) changes.push(`workspaceId ${prev.workspaceId} -> ${workspaceId}`);
    if (prev.actorId !== actorId) changes.push(`actorId ${prev.actorId} -> ${actorId}`);
    if (prev.workspaceResetNonce !== workspaceResetNonce) {
      changes.push(`workspaceResetNonce ${prev.workspaceResetNonce} -> ${workspaceResetNonce}`);
    }
    if (prev.retryNonce !== retryNonce) changes.push(`retryNonce ${prev.retryNonce} -> ${retryNonce}`);
    if (prev.authVerified !== authVerified) {
      changes.push(`authVerified ${prev.authVerified} -> ${authVerified}`);
    }
    if (changes.length > 0) {
      log.info(`[WorkspaceStoreInitializer] Init dependencies changed: ${changes.join('; ')}`);
    }
    prevDepsRef.current = { workspaceId, actorId, workspaceResetNonce, retryNonce, authVerified };
  });

  useEffect(() => {
    useUndoStore.getState().setWorkspaceId(workspaceId);
  }, [workspaceId]);

  // Diagnostic logging: a force re-sync locks the UI with a modal; log when it
  // starts/stops so we can tell if the blank reload coincides with one.
  const prevForceResyncRef = useRef(forceResyncWorkspaceId);
  useEffect(() => {
    const prev = prevForceResyncRef.current;
    if (prev === forceResyncWorkspaceId) return;
    prevForceResyncRef.current = forceResyncWorkspaceId;
    log.info('[WorkspaceStoreInitializer] Force resync state changed', {
      from: prev,
      to: forceResyncWorkspaceId,
    });
  }, [forceResyncWorkspaceId]);

  useEffect(() => {
    if (!workspaceId || !authVerified || actorId === 'anonymous') {
      setCtx(undefined);
      setReadyWorkspaceId(null);
      setInitError(null);
      setRetryNonce(0);
      return;
    }

    log.info('[WorkspaceStoreInitializer] Starting workspace init', {
      workspaceId,
      actorId,
      resetNonce: workspaceResetNonce,
      retryNonce,
    });

    let cancelled = false;
    setInitError(null);
    setPhaseMessage('Loading workspaces…');
    const transport = createHttpTransport(workspaceId, actorId);

    useSyncStatusStore.getState().setWorkspaceInitializing(workspaceId, true);
    getOrCreateWorkspaceStore(workspaceId, actorId, transport, {
      onOpenProgress: ({ message }) => {
        if (!cancelled) setPhaseMessage(message);
      },
      syncCallbacks: {
        onSyncPhase: (_phase, message) => {
          if (!cancelled) setPhaseMessage(message);
        },
        onStatusChange: (status, error) => {
          const s = useSyncStatusStore.getState();
          if (status === 'syncing') {
            s.setStatus('syncing');
          } else if (status === 'error') {
            s.setStatus('error', { lastError: error?.message ?? 'Sync error' });
          } else {
            s.setStatus('synced');
          }
        },
        onPullProgress: (p) => {
          useSyncStatusStore.getState().setWorkspacePullProgress(workspaceId, p);
        },
        onPull: (count) => {
          const s = useSyncStatusStore.getState();
          s.setWorkspacePullProgress(workspaceId, null);
          s.setWorkspaceInitializing(workspaceId, false);
          if (count > 0) {
            s.setStatus('synced');
          }
        },
        onError: (error) => {
          const s = useSyncStatusStore.getState();
          s.setStatus('error', { lastError: error.message });
          s.setWorkspaceInitializing(workspaceId, false);
        },
      },
    })
      .then(() => {
        if (cancelled) return;
        log.info('[WorkspaceStoreInitializer] Workspace init complete', { workspaceId });
        setCtx({ actorId, transport });
        setReadyWorkspaceId(workspaceId);
        // The open promise now waits for the initial sync to finish (or fail),
        // so the workspace is fully initialized at this point.
        useSyncStatusStore.getState().setWorkspaceInitializing(workspaceId, false);
        const syncEngine = getWorkspaceSyncEngine(workspaceId);
        if (syncEngine) {
          unregisterVisibilityRef.current = registerVisibilitySync(syncEngine);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          log.error(`Failed to initialize workspace store ${workspaceId}`, err);
          setInitError(err instanceof Error ? err : new Error(String(err)));
          setReadyWorkspaceId(null);
        }
        if (workspaceId) {
          useSyncStatusStore.getState().setWorkspaceInitializing(workspaceId, false);
        }
      });

    return () => {
      cancelled = true;
      unregisterVisibilityRef.current?.();
      unregisterVisibilityRef.current = null;
      if (workspaceId) {
        log.info('[WorkspaceStoreInitializer] Cleaning up workspace', { workspaceId });
        useSyncStatusStore.getState().setWorkspaceInitializing(workspaceId, false);
        closeWorkspaceStore(workspaceId).catch((err) => {
          log.error(`Failed to close workspace ${workspaceId}`, err);
        });
      }
    };
  }, [workspaceId, actorId, workspaceResetNonce, retryNonce, authVerified]);

  const isWaitingForWorkspaces = !!user && authVerified && isLoadingWorkspaces;
  const isReady =
    !!workspaceId && readyWorkspaceId === workspaceId && !isInitializing && !initError;
  const showOverlay = (!!workspaceId && !isReady) || isWaitingForWorkspaces || isWorkspacesError;

  const progressPercent = showOverlay && pullProgress
    ? pullProgress.total > 0
      ? Math.round((pullProgress.applied / pullProgress.total) * 100)
      : 0
    : undefined;
  const workspaceLoadingLabel = showWorkspaceTimeout
    ? 'Loading workspaces is taking longer than expected…'
    : 'Loading workspaces…';
  const progressLabel =
    progressPercent !== undefined
      ? `${phaseMessage} (${progressPercent}%)`
      : isWaitingForWorkspaces
        ? workspaceLoadingLabel
        : phaseMessage;
  const prevShowOverlayRef = useRef(showOverlay);
  useEffect(() => {
    if (prevShowOverlayRef.current === showOverlay) return;
    prevShowOverlayRef.current = showOverlay;
    if (showOverlay) {
      log.info('[WorkspaceStoreInitializer] Showing workspace overlay', {
        workspaceId,
        phaseMessage,
        isInitializing,
        isLoadingWorkspaces,
        initError: initError?.message,
      });
    } else {
      log.info('[WorkspaceStoreInitializer] Hiding workspace overlay', { workspaceId, readyWorkspaceId });
    }
  }, [showOverlay, workspaceId, phaseMessage, isInitializing, isLoadingWorkspaces, initError, readyWorkspaceId]);

  const progressValue = showOverlay && pullProgress
    ? pullProgress.total > 0
      ? pullProgress.applied / pullProgress.total
      : 0
    : undefined;

  // Once the workspace has become ready, keep the children mounted behind any
  // later loading overlay. This prevents the whole UI from unmounting and
  // remounting when a brief sync/loading state fires while the workspace is
  // already open.
  const [keptChildrenWorkspaceId, setKeptChildrenWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    if (isReady && workspaceId && keptChildrenWorkspaceId !== workspaceId) {
      setKeptChildrenWorkspaceId(workspaceId);
    }
  }, [isReady, workspaceId, keptChildrenWorkspaceId]);
  useEffect(() => {
    if (keptChildrenWorkspaceId !== null && keptChildrenWorkspaceId !== workspaceId) {
      setKeptChildrenWorkspaceId(null);
    }
  }, [workspaceId, keptChildrenWorkspaceId]);
  const keepChildrenMounted = !!workspaceId && keptChildrenWorkspaceId === workspaceId;

  // Render children for non-workspace routes (auth/onboarding) immediately, and
  // for workspace routes once we've been ready at least once for the current
  // workspace. The loading overlay is then rendered on top instead of replacing
  // the children, which stops the blank re-render loop.
  const shouldRenderChildren = !workspaceId || isReady || keepChildrenMounted;

  return (
    <>
      {shouldRenderChildren &&
        (ctx ? (
          <WorkspaceStoreProvider actorId={ctx.actorId} transport={ctx.transport}>
            {children}
            {workspaceId && <SyncConflictListener workspaceId={workspaceId} />}
          </WorkspaceStoreProvider>
        ) : (
          children
        ))}
      {showOverlay && (
        <>
          {isWorkspacesError ? (
            <div className="workspace-init-overlay workspace-init-overlay--error" role="alert">
              <h1 className="workspace-init-error__title">Failed to load workspaces</h1>
              <p className="workspace-init-error__message">
                {workspacesError instanceof Error ? workspacesError.message : 'Could not fetch workspaces'}
              </p>
              <Button
                onClick={() => {
                  setShowWorkspaceTimeout(false);
                  void refetchWorkspaces();
                }}
              >
                Retry
              </Button>
            </div>
          ) : initError ? (
            <div className="workspace-init-overlay workspace-init-overlay--error" role="alert">
              <h1 className="workspace-init-error__title">Failed to load workspace</h1>
              <p className="workspace-init-error__message">{initError.message}</p>
              <Button
                onClick={() => {
                  clearSqlInitError();
                  setRetryNonce((n) => n + 1);
                }}
              >
                Retry
              </Button>
            </div>
          ) : (
            <LoadingScreen
              label={progressLabel}
              progress={progressValue}
              className="workspace-init-overlay"
            />
          )}
        </>
      )}
      {forceResyncWorkspaceId && (
        <SyncProgressModal
          isOpen
          label={`Re-syncing workspace… ${
            forceResyncPullProgress && forceResyncPullProgress.total > 0
              ? Math.round(
                  (forceResyncPullProgress.applied /
                    forceResyncPullProgress.total) *
                    100
                ) + '%'
              : ''
          }`}
          progress={
            forceResyncPullProgress && forceResyncPullProgress.total > 0
              ? forceResyncPullProgress.applied / forceResyncPullProgress.total
              : undefined
          }
        />
      )}
    </>
  );
}

function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <KeyboardShortcutsProvider>
      <DndProvider>
        <AuthSyncListener />
        <GlobalKeyboardHandler />
        <CommandRegistrations />
        {children}
      </DndProvider>
    </KeyboardShortcutsProvider>
  );
}

export { App };
