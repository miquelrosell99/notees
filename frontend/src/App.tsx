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
import { useEffect, useMemo } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { queryClient, workspaceAwarePersister, setPersistWorkspaceUuid } from './lib/queryClient';
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
import { SyncManagerV2 } from '@/features/sync/SyncManagerV2';
import { LocalIndexManager } from '@/features/sync/components/LocalIndexManager';
import { QueryLiveUpdater } from '@/features/sync/components/QueryLiveUpdater';
import { useBackendHealth } from './hooks/useBackendHealth';
import { useBackgroundSync } from './hooks/useBackgroundSync';
import { useWorkspaces } from '@/features/workspace';
import { BackendUnavailableOverlay } from './components/ui/BackendUnavailableOverlay';
import { getLogger } from './utils/logger';
import { pluginManager } from '@/plugins/core';
import './App.css';

const log = getLogger('App');

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
  useEffect(() => {
    if (appInitialized) return;
    appInitialized = true;
    log.info('Notees application initialized', {
      version: import.meta.env.VITE_APP_VERSION || 'dev',
      mode: import.meta.env.MODE,
    });

    // Load frontend plugins. Built-in plugins are bundled; user plugins are
    // fetched from the backend and imported dynamically.
    pluginManager.loadPlugins().catch((err) => {
      log.error('Failed to load plugins', err);
    });
  }, []);

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <EncryptedPersistProvider>
        <KeyboardShortcutsProvider>
          <DndProvider>
            <AuthSyncListener />
            <GlobalKeyboardHandler />
            <CommandRegistrations />
            <SyncManagerV2 />
            <LocalIndexManager />
            <QueryLiveUpdater />
            <BrowserRouter>
              <ErrorBoundary context="App">
                <AppContent />
              </ErrorBoundary>
            </BrowserRouter>
            <ConnectedNotificationToast />
          </DndProvider>
        </KeyboardShortcutsProvider>
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
  const { data: workspacesData } = useWorkspaces({ enabled: true });
  const activeWorkspace = useMemo(() => {
    if (!workspacesData?.items) return null;
    return workspacesData.items.find((ws) => ws.is_active) ?? workspacesData.items[0] ?? null;
  }, [workspacesData]);
  const workspaceUuid = activeWorkspace?.uuid ?? null;

  useEffect(() => {
    setPersistWorkspaceUuid(workspaceUuid);
    // Clear the in-memory cache when the active workspace changes so that
    // cached data from one workspace is never displayed under another.
    queryClient.clear();
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

export { App };
