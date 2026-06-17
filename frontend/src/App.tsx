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
import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { queryClient, asyncStoragePersister } from './lib/queryClient';
import { NotificationToast, type ToastNotification } from './components/ui/NotificationToast';
import { useNotificationStore, type Notification } from './stores/notificationStore';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { KeyboardShortcutsProvider } from './hooks/KeyboardShortcutsProvider';
import { useGlobalKeyboardListener } from './hooks/useGlobalKeyboardListener';
import { useWindowFocusActiveBlock } from './hooks/useWindowFocusActiveBlock';
import { useCommand } from './hooks/useCommand';
import { useUndoStackPersistence } from '@/features/layout/hooks/useUndoStackPersistence';
import { COMMAND_IDS } from './stores/commandRegistry';
import { DndProvider } from './providers/DndProvider';
import { useUndoStore } from './stores';
import { useAndroidBridge } from './hooks';
import { AppRoutes } from './features/layout/components/AppRoutes';
import { CommandRegistrations } from './features/commands';
import { SyncManager } from './sync';
import { getLogger } from './utils/logger';
import './App.css';
import './focus-mode.css';

const log = getLogger('App');

/**
 * Global keyboard listener component
 * Sets up the centralized keyboard event handler
 */
function GlobalKeyboardHandler() {
  useGlobalKeyboardListener();
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

  return null;
}

function AppContent() {
  // Register the Android bridge as early as possible — before auth gates — so
  // the native shell can call window.noteesBridge even while the app is loading.
  useAndroidBridge();
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
  }, []);

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: asyncStoragePersister,
          maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
          dehydrateOptions: {
            shouldDehydrateQuery: (query) => {
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
        }}
      >
        <KeyboardShortcutsProvider>
          <DndProvider>
            <GlobalKeyboardHandler />
            <CommandRegistrations />
            <SyncManager />
            <BrowserRouter>
              <ErrorBoundary context="App">
                <AppContent />
              </ErrorBoundary>
            </BrowserRouter>
            <ConnectedNotificationToast />
          </DndProvider>
        </KeyboardShortcutsProvider>
      </PersistQueryClientProvider>
    </>
  );
}

export { App };
