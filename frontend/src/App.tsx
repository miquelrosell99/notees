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
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { settingsKeys } from './hooks/queryKeys';
import { getSettings } from './api/workspaces';
const Layout = React.lazy(() => import('./components/layout/Layout').then(m => ({ default: m.Layout })));
const LoginView = React.lazy(() => import('./views/LoginView').then(m => ({ default: m.LoginView })));
const WorkspaceManagementView = React.lazy(() => import('./views/WorkspaceManagementView').then(m => ({ default: m.WorkspaceManagementView })));
const EnrollmentView = React.lazy(() => import('./views/EnrollmentView').then(m => ({ default: m.EnrollmentView })));
import { NotificationToast } from './components/core/NotificationToast';
import { ErrorBoundary } from './components/core/ErrorBoundary';
import { KeyboardShortcutsProvider, useGlobalKeyboardListener } from './hooks/useKeyboardShortcuts';
import { DndProvider } from './providers/DndProvider';
import { listWorkspaces } from './api/workspaces';
import { useAuthStore, useModalStore, useFavoritesStore, useKeyboardStore, useUndoStore } from './stores';
import { useAndroidBridge } from './hooks';
import { SHORTCUT_IDS } from './stores/keyboardStore';
import type { User } from './types/api';
import { getLogger } from './utils/logger';
import { getAuthToken, clearAuthToken, getUserData } from './utils/auth';
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
  
  // Register global undo/redo shortcut handlers
  useEffect(() => {
    const { registerHandler } = useKeyboardStore.getState();
    
    const unregisterUndo = registerHandler(SHORTCUT_IDS.UNDO, () => {
      // If a Lexical editor is focused, let it handle its own undo
      const active = document.activeElement;
      if (active?.closest('[data-lexical-editor]')) return false;
      useUndoStore.getState().performUndo(queryClient);
    }, 0);
    
    const unregisterRedo = registerHandler(SHORTCUT_IDS.REDO, () => {
      const active = document.activeElement;
      if (active?.closest('[data-lexical-editor]')) return false;
      useUndoStore.getState().performRedo(queryClient);
    }, 0);
    
    const unregisterRedoAlt = registerHandler(SHORTCUT_IDS.REDO_ALT, () => {
      const active = document.activeElement;
      if (active?.closest('[data-lexical-editor]')) return false;
      useUndoStore.getState().performRedo(queryClient);
    }, 0);
    
    return () => {
      unregisterUndo();
      unregisterRedo();
      unregisterRedoAlt();
    };
  }, []);
  
  return null;
}

function AppContent() {
  // Register the Android bridge as early as possible — before auth gates — so
  // the native shell can call window.noteesBridge even while the app is loading.
  useAndroidBridge();

  const { isAuthenticated, isLoading, logout } = useAuthStore();
  const { toggleScratchpad, toggleCalendar, showWorkspaceManager, setShowWorkspaceManager } = useModalStore();
  
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
      setNeedsEnrollment(false);
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
  
  // Check auth on mount
  useEffect(() => {
    log.info('Checking authentication state...');
    const token = getAuthToken();
    const user = getUserData();
    
    if (token && user) {
      const typedUser = user as User;
      log.debug('Found stored auth, restoring session', { username: typedUser.username });
      useAuthStore.getState().setUser(typedUser);
    } else {
      log.debug('No valid stored auth found');
      // Clear any partial auth data
      if (token || user) {
        clearAuthToken();
      }
    }
  }, []);
  
  // Register keyboard shortcut handlers when authenticated
  // Use refs to avoid re-registering when callbacks change identity
  const toggleScratchpadRef = useRef(toggleScratchpad);
  const toggleCalendarRef = useRef(toggleCalendar);
  
  // Keep refs updated
  useEffect(() => {
    toggleScratchpadRef.current = toggleScratchpad;
    toggleCalendarRef.current = toggleCalendar;
  });
  
  useEffect(() => {
    if (!isAuthenticated) return;
    
    const { registerHandler } = useKeyboardStore.getState();
    
    // Scratchpad shortcut (Ctrl/Cmd + N)
    const unregisterQuickAdd = registerHandler('quickAdd', () => {
      toggleScratchpadRef.current();
    });
    
    // Calendar shortcut (Ctrl/Cmd + Shift + D)
    const unregisterCalendar = registerHandler('goToDaily', () => {
      toggleCalendarRef.current();
    });
    
    return () => {
      unregisterQuickAdd();
      unregisterCalendar();
    };
  }, [isAuthenticated]);
  
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
  
  if (isLoading) {
    log.debug('Showing loading screen');
    return (
      <div className="loading-screen">
        <div className="loading-spinner">Loading...</div>
      </div>
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
      <Suspense fallback={<div className="loading-screen"><div className="loading-spinner">Loading...</div></div>}>
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
        <div className="loading-spinner">Loading...</div>
      </div>
    );
  }
  
  if (needsEnrollment) {
    return (
      <Suspense fallback={<div className="loading-screen"><div className="loading-spinner">Loading...</div></div>}>
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
        <div className="loading-spinner">Loading...</div>
      </div>
    );
  }
  
  // Show workspace management if no workspaces exist or no active workspace
  const hasNoWorkspaces = !dbData?.workspaces || dbData.workspaces.length === 0;
  const hasNoActiveWorkspace = !dbData?.active;
  
  if (hasNoWorkspaces || hasNoActiveWorkspace || showWorkspaceManager) {
    log.debug('Showing workspace management view', { hasNoWorkspaces, hasNoActiveWorkspace, showWorkspaceManager });
    return (
      <Suspense fallback={<div className="loading-screen"><div className="loading-spinner">Loading...</div></div>}>
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
        <div className="loading-spinner">Loading...</div>
      </div>
    );
  }
  
  log.debug('User authenticated, showing main layout');
  return (
    <Suspense fallback={<div className="loading-screen"><div className="loading-spinner">Loading...</div></div>}>
      <ErrorBoundary>
        <Layout />
      </ErrorBoundary>
    </Suspense>
  );
}

function App() {
  useEffect(() => {
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
      <QueryClientProvider client={queryClient}>
        <KeyboardShortcutsProvider>
          <DndProvider>
            <GlobalKeyboardHandler />
            <ErrorBoundary context="App">
              <AppContent />
            </ErrorBoundary>
            <NotificationToast />
          </DndProvider>
        </KeyboardShortcutsProvider>
      </QueryClientProvider>
    </>
  );
}

export { App };
