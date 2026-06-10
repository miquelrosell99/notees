/**
 * Main application component
 * 
 * Architecture:
 * - QueryClientProvider: TanStack Query for server state
 * - KeyboardShortcutsProvider: Centralized keyboard shortcut handling
 * - ErrorBoundary: Graceful error recovery
 * - NotificationToast: Global notification display
 */
import React, { useEffect, useRef, useState, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { queryClient, asyncStoragePersister } from './lib/queryClient';
import { settingsKeys } from './hooks/queryKeys';
import { getSettings } from './api/workspaces';
const Layout = React.lazy(() => import('./components/layout/Layout').then(m => ({ default: m.Layout })));
const LoginView = React.lazy(() => import('./views/LoginView').then(m => ({ default: m.LoginView })));
const WorkspaceManagementView = React.lazy(() => import('./views/WorkspaceManagementView').then(m => ({ default: m.WorkspaceManagementView })));
const EnrollmentView = React.lazy(() => import('./views/EnrollmentView').then(m => ({ default: m.EnrollmentView })));
const InviteAcceptView = React.lazy(() => import('./views/InviteAcceptView').then(m => ({ default: m.InviteAcceptView })));
const PublicShareView = React.lazy(() => import('./views/PublicShareView').then(m => ({ default: m.PublicShareView })));
const OnboardingView = React.lazy(() => import('./views/OnboardingView').then(m => ({ default: m.OnboardingView })));
import { NotificationToast } from './components/core/NotificationToast';
import { LoadingScreen } from './components/core/LoadingScreen';
import { QuickAddModal } from './components/layout/QuickAddModal';
import { ErrorBoundary } from './components/core/ErrorBoundary';
import { KeyboardShortcutsProvider } from './hooks/KeyboardShortcutsProvider';
import { useGlobalKeyboardListener } from './hooks/useGlobalKeyboardListener';
import { useCommand } from './hooks/useCommand';
import { COMMAND_IDS } from './stores/commandRegistry';
import { DndProvider } from './providers/DndProvider';
import { listWorkspaces } from './api/workspaces';
import { useAuthStore, useModalStore, useFavoritesStore, useUndoStore } from './stores';
import { useAndroidBridge } from './hooks';
// SHORTCUT_IDS removed — commands now use COMMAND_IDS from commandRegistry
import type { User } from './types/api';
import { getLogger } from './utils/logger';
import { getAuthToken, clearAuthToken, getUserData } from './utils/auth';
import { getAuthStatus } from './api/auth';
import { clearScratchpad } from './api/nodes';
import './App.css';
import './focus-mode.css';

const log = getLogger('App');

/**
 * Global keyboard listener component
 * Sets up the centralized keyboard event handler
 */
function GlobalKeyboardHandler() {
  useGlobalKeyboardListener();

  // Register global commands in the Command Registry
  useCommand(COMMAND_IDS.UNDO, () => {
    const active = document.activeElement;
    if (active?.closest('[data-lexical-editor]')) return false;
    useUndoStore.getState().performUndo(queryClient);
  }, { label: 'Undo' });

  useCommand(COMMAND_IDS.REDO, () => {
    const active = document.activeElement;
    if (active?.closest('[data-lexical-editor]')) return false;
    useUndoStore.getState().performRedo(queryClient);
  }, { label: 'Redo' });

  useCommand(COMMAND_IDS.REDO_ALT, () => {
    const active = document.activeElement;
    if (active?.closest('[data-lexical-editor]')) return false;
    useUndoStore.getState().performRedo(queryClient);
  }, { label: 'Redo' });

  return null;
}

function AppContent() {
  // Register the Android bridge as early as possible — before auth gates — so
  // the native shell can call window.noteesBridge even while the app is loading.
  useAndroidBridge();

  const { isAuthenticated, isLoading, logout } = useAuthStore();
  const { toggleCalendar, showWorkspaceManager, setShowWorkspaceManager } = useModalStore();
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);

  // First-boot / onboarding check
  const [bootChecked, setBootChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getAuthStatus()
      .then((status) => {
        if (!cancelled) {
          setNeedsOnboarding(status.needs_onboarding);
          setRegistrationEnabled(status.registration_enabled);
          setBootChecked(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNeedsOnboarding(false);
          setBootChecked(true);
        }
      });
    return () => { cancelled = true; };
  }, []);

  // Fetch workspaces when authenticated
  const { data: dbData, isLoading: isLoadingWorkspaces, refetch: refetchWorkspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => listWorkspaces(),
    enabled: isAuthenticated,
    staleTime: 10000,
    select: (data) => ({
      workspaces: data.items,
      active: data.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });
  
  // Check enrollment status from user settings (useQuery avoids setState-in-effect)
  const { isLoading: isCheckingEnrollment, data: enrollmentSettings } = useQuery({
    queryKey: settingsKeys.all,
    queryFn: getSettings,
    enabled: isAuthenticated,
    staleTime: Infinity,
  });
  const needsEnrollment = enrollmentSettings
    ? String(enrollmentSettings['enrollment_completed']) !== 'true'
    : false;
  
  // Listen for unauthorized events and logout
  useEffect(() => {
    const handleUnauthorized = () => {
      log.warn('Received unauthorized event, logging out');
      logout();
    };
    
    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, [logout]);
  
  // Check auth on mount (module-level guard prevents double-run in StrictMode)
  const authRestoredRef = useRef(false);
  useEffect(() => {
    if (authRestoredRef.current) return;
    authRestoredRef.current = true;
    log.info('Checking authentication state...');
    const token = getAuthToken();
    const user = getUserData();
    
    if (token && user) {
      const typedUser = user as User;
      log.debug('Found stored auth, restoring session', { email: typedUser.email });
      useAuthStore.getState().setUser(typedUser);
    } else {
      log.debug('No valid stored auth found');
      // Clear any partial auth data
      if (token || user) {
        clearAuthToken();
      }
    }
  }, []);
  
  // Register keyboard commands when authenticated
  useCommand(COMMAND_IDS.QUICK_ADD, () => {
    setIsQuickAddOpen((prev) => !prev);
  }, { enabled: isAuthenticated, label: 'Open Quick Add' });

  useCommand(COMMAND_IDS.GO_TODAY, () => {
    toggleCalendar();
  }, { enabled: isAuthenticated, label: 'Go to Today' });
  
  // Settings are already fetched above for enrollment check. Re-use that query
  // for the Layout gate instead of firing a duplicate GET /settings.
  const settingsLoaded = !!enrollmentSettings;
  const isLoadingSettings = isCheckingEnrollment;

  // Load favorites and recents AFTER critical requests complete.
  // Defer by 1.5s so the browser's 6-connection pool is free for
  // daily-node, workspace, and page-list requests first.
  useEffect(() => {
    if (!settingsLoaded) return;
    const timer = setTimeout(() => {
      const store = useFavoritesStore.getState();
      store.loadFavorites();
      store.loadRecents();
      clearScratchpad().catch(() => {/* ignore — scratchpad may not exist yet */});
    }, 1500);
    return () => clearTimeout(timer);
  }, [settingsLoaded]);
  
  useEffect(() => {
    log.debug('Auth state changed', { isAuthenticated, isLoading });
  }, [isAuthenticated, isLoading]);
  
  if (isLoading || !bootChecked) {
    log.debug('Showing loading screen');
    return <LoadingScreen label="Loading…" />;
  }

  // Public share links work without authentication
  const isPublicSharePath = window.location.pathname.startsWith('/s/');
  const isInvitePath = window.location.pathname === '/enroll';

  if (!isAuthenticated && isPublicSharePath) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <PublicShareView />
      </Suspense>
    );
  }

  if (isInvitePath) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <InviteAcceptView />
      </Suspense>
    );
  }

  // First-boot onboarding: create admin account before any login
  if (needsOnboarding) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <OnboardingView onComplete={() => setNeedsOnboarding(false)} />
      </Suspense>
    );
  }

  if (!isAuthenticated) {
    log.debug('User not authenticated, showing login page');
    // Store the current URL to restore after login (if not already on /auth)
    if (window.location.pathname !== '/auth') {
      const intendedUrl = window.location.pathname;
      if (intendedUrl !== '/') {
        sessionStorage.setItem('intendedUrl', intendedUrl);
      }
      window.history.replaceState(null, '', '/auth');
    }
    return (
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <LoginView registrationEnabled={registrationEnabled} />
      </Suspense>
    );
  }
  
  // Redirect away from /auth when authenticated
  if (window.location.pathname === '/auth') {
    // Restore the intended URL if we have one
    const intendedUrl = sessionStorage.getItem('intendedUrl');
    sessionStorage.removeItem('intendedUrl');
    window.history.replaceState(null, '', intendedUrl || '/');
  }
  
  // Show enrollment for first-time users
  if (isCheckingEnrollment) {
    return <LoadingScreen label="Loading…" />;
  }
  
  if (needsEnrollment) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <EnrollmentView onComplete={() => queryClient.invalidateQueries({ queryKey: ['enrollment-check'] })} />
      </Suspense>
    );
  }
  
  // Show loading while checking workspaces — but NOT when the workspace manager
  // is explicitly pinned (e.g. during a Logseq import).  queryClient.clear() wipes
  // the workspaces cache temporarily; skipping the spinner keeps WMV mounted so
  // ImportOptionsModal state (progress UI) survives the cache rebuild.
  if (isLoadingWorkspaces && !showWorkspaceManager) {
    log.debug('Loading workspaces...');
    return <LoadingScreen label="Loading workspace…" />;
  }
  
  // Show workspace management if no workspaces exist or no active workspace
  const hasNoWorkspaces = !dbData?.workspaces || dbData.workspaces.length === 0;
  const hasNoActiveWorkspace = !dbData?.active;
  
  if (hasNoWorkspaces || hasNoActiveWorkspace || showWorkspaceManager) {
    log.debug('Showing workspace management view', { hasNoWorkspaces, hasNoActiveWorkspace, showWorkspaceManager });
    return (
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <WorkspaceManagementView 
          onWorkspaceSelected={() => {
            setShowWorkspaceManager(false);
            refetchWorkspaces();
          }}
          showClose={!hasNoWorkspaces && !hasNoActiveWorkspace}
          onClose={() => setShowWorkspaceManager(false)}
        />
      </Suspense>
    );
  }
  
  // Show loading while settings are loading (prevents request flood)
  if (isLoadingSettings) {
    return <LoadingScreen label="Loading…" />;
  }
  
  log.debug('User authenticated, showing main layout');
  return (
    <>
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <ErrorBoundary>
          <Layout />
        </ErrorBoundary>
      </Suspense>
      <QuickAddModal isOpen={isQuickAddOpen} onClose={() => setIsQuickAddOpen(false)} />
    </>
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
            // that cannot be safely JSON-serialised; restoring them causes
            // "promise.then is not a function" errors during hydration.
            shouldDehydrateMutation: () => false,
          },
        }}
      >
        <KeyboardShortcutsProvider>
          <DndProvider>
            <GlobalKeyboardHandler />
            <ErrorBoundary context="App">
              <AppContent />
            </ErrorBoundary>
            <NotificationToast />
          </DndProvider>
        </KeyboardShortcutsProvider>
      </PersistQueryClientProvider>
    </>
  );
}

export { App };
