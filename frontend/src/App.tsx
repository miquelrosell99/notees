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
const PublicShareView = React.lazy(() => import('./views/PublicShareView').then(m => ({ default: m.PublicShareView })));
const OnboardingView = React.lazy(() => import('./views/OnboardingView').then(m => ({ default: m.OnboardingView })));
import { NotificationToast } from './components/core/NotificationToast';
import { Spinner } from './components/core/Spinner';
import { QuickAddModal } from './components/layout/QuickAddModal';
import { ErrorBoundary } from './components/core/ErrorBoundary';
import { KeyboardShortcutsProvider, useGlobalKeyboardListener, useCommand, COMMAND_IDS } from './hooks/useKeyboardShortcuts';
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

  useEffect(() => {
    let cancelled = false;
    getAuthStatus()
      .then((status) => {
        if (!cancelled) {
          setNeedsOnboarding(status.needs_onboarding);
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
    queryFn: listWorkspaces,
    enabled: isAuthenticated,
    staleTime: 10000,
  });
  
  // Check enrollment status from user settings
  const [enrollmentChecked, setEnrollmentChecked] = useState(false);
  const [needsEnrollment, setNeedsEnrollment] = useState(false);
  
  useEffect(() => {
    if (!isAuthenticated) {
      setEnrollmentChecked(false);
        setNeedsEnrollment(false);;
      return;
    }
    
    // Fetch user settings to check enrollment status
    getSettings().then((settings) => {
      const completed = settings['enrollment_completed'];
      setNeedsEnrollment(String(completed) !== 'true');
      setEnrollmentChecked(true);
    }).catch(() => {
      // If settings fetch fails, skip enrollment
      setEnrollmentChecked(true);
      setNeedsEnrollment(false);
    });
  }, [isAuthenticated]);
  
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
  
  // Gate Layout behind settings: fetch settings BEFORE Layout mounts.
  // This ensures GET /settings completes before journal/workspace views
  // start their request flood, so settings doesn't compete for browser connections.
  // Also loads favorites and recents after settings to avoid connection contention.
  const [settingsReady, setSettingsReady] = useState(false);
  useEffect(() => {
    if (dbData?.active) {
      queryClient.fetchQuery({
        queryKey: settingsKeys.all,
        queryFn: getSettings,
        staleTime: 1000 * 60 * 5,
      }).then(() => {
        setSettingsReady(true);
        // Load favorites and recents AFTER settings — prevents connection contention
        const store = useFavoritesStore.getState();
        store.loadFavorites();
        store.loadRecents();
        // Clear scratchpad blocks from previous session
        clearScratchpad().catch(() => {/* ignore — scratchpad may not exist yet */});
      }).catch(() => {
        // Still render Layout even if settings fail — degrade gracefully
        setSettingsReady(true);
        const store = useFavoritesStore.getState();
        store.loadFavorites();
        store.loadRecents();
        clearScratchpad().catch(() => {});
      });
    } else {
      setSettingsReady(false);
    }
  }, [dbData?.active]);
  
  useEffect(() => {
    log.debug('Auth state changed', { isAuthenticated, isLoading });
  }, [isAuthenticated, isLoading]);
  
  if (isLoading || !bootChecked) {
    log.debug('Showing loading screen');
    return (
      <div className="loading-screen">
        <Spinner size="lg" centered />
      </div>
    );
  }

  // Public share links work without authentication
  const isPublicSharePath = window.location.pathname.startsWith('/s/');

  if (!isAuthenticated && isPublicSharePath) {
    return (
      <Suspense fallback={<div className="loading-screen"><Spinner size="lg" centered /></div>}>
        <PublicShareView />
      </Suspense>
    );
  }

  // First-boot onboarding: create admin account before any login
  if (needsOnboarding) {
    return (
      <Suspense fallback={<div className="loading-screen"><Spinner size="lg" centered /></div>}>
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
      <Suspense fallback={<div className="loading-screen"><Spinner size="lg" centered /></div>}>
        <LoginView />
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
  if (!enrollmentChecked) {
    return (
      <div className="loading-screen">
        <Spinner size="lg" centered />
      </div>
    );
  }
  
  if (needsEnrollment) {
    return (
      <Suspense fallback={<div className="loading-screen"><Spinner size="lg" centered /></div>}>
        <EnrollmentView onComplete={() => setNeedsEnrollment(false)} />
      </Suspense>
    );
  }
  
  // Show loading while checking workspaces — but NOT when the workspace manager
  // is explicitly pinned (e.g. during a Logseq import).  queryClient.clear() wipes
  // the workspaces cache temporarily; skipping the spinner keeps WMV mounted so
  // ImportOptionsModal state (progress UI) survives the cache rebuild.
  if (isLoadingWorkspaces && !showWorkspaceManager) {
    log.debug('Loading workspaces...');
    return (
      <div className="loading-screen">
        <Spinner size="lg" centered />
      </div>
    );
  }
  
  // Show workspace management if no workspaces exist or no active workspace
  const hasNoWorkspaces = !dbData?.workspaces || dbData.workspaces.length === 0;
  const hasNoActiveWorkspace = !dbData?.active;
  
  if (hasNoWorkspaces || hasNoActiveWorkspace || showWorkspaceManager) {
    log.debug('Showing workspace management view', { hasNoWorkspaces, hasNoActiveWorkspace, showWorkspaceManager });
    return (
      <Suspense fallback={<div className="loading-screen"><Spinner size="lg" centered /></div>}>
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
  if (!settingsReady) {
    return (
      <div className="loading-screen">
        <Spinner size="lg" centered />
      </div>
    );
  }
  
  log.debug('User authenticated, showing main layout');
  return (
    <>
      <Suspense fallback={<div className="loading-screen"><Spinner size="lg" centered /></div>}>
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
              // Only persist query data, not mutations or infinite queries
              const queryKey = query.queryKey as string[];
              if (!queryKey || queryKey.length === 0) return false;
              // Exclude auth-related queries
              if (queryKey[0] === 'auth') return false;
              return true;
            },
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
