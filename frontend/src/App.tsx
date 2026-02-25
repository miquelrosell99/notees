/**
 * Main application component
 * 
 * Architecture:
 * - QueryClientProvider: TanStack Query for server state
 * - KeyboardShortcutsProvider: Centralized keyboard shortcut handling
 * - ErrorBoundary: Graceful error recovery
 * - NotificationToast: Global notification display
 */
import { useEffect, useRef, useState } from 'react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { settingsKeys } from './hooks/queryKeys';
import { getSettings } from './api/workspaces';
import { Layout } from './components/layout/Layout';
import { LoginView } from './views/LoginView';
import { WorkspaceManagementView } from './views/WorkspaceManagementView';
import { EnrollmentView } from './views/EnrollmentView';
import { NotificationToast } from './components/core/NotificationToast';
import { ErrorBoundary } from './components/core/ErrorBoundary';
import { KeyboardShortcutsProvider, useGlobalKeyboardListener } from './hooks/useKeyboardShortcuts';
import { DndProvider } from './providers/DndProvider';
import { listWorkspaces } from './api/workspaces';
import { useAuthStore, useAppStore, useFavoritesStore, useKeyboardStore } from './stores';
import { getLogger } from './utils/logger';
import { getAuthToken, clearAuthToken, getUserData } from './utils/auth';
import './App.css';
import './focus-mode.css';

const log = getLogger('App');

/**
 * Global keyboard listener component
 * Sets up the centralized keyboard event handler
 */
function GlobalKeyboardHandler() {
  useGlobalKeyboardListener();
  return null;
}

function AppContent() {
  const { isAuthenticated, isLoading, logout } = useAuthStore();
  const { toggleQuickAdd, toggleCalendar, showWorkspaceManager, setShowWorkspaceManager } = useAppStore();
  
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
      setNeedsEnrollment(completed !== 'true' && completed !== true as any);
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
      log.debug('Found stored auth, restoring session', { username: (user as any).username });
      useAuthStore.getState().setUser(user as any);
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
  const toggleQuickAddRef = useRef(toggleQuickAdd);
  const toggleCalendarRef = useRef(toggleCalendar);
  
  // Keep refs updated
  useEffect(() => {
    toggleQuickAddRef.current = toggleQuickAdd;
    toggleCalendarRef.current = toggleCalendar;
  });
  
  useEffect(() => {
    if (!isAuthenticated) return;
    
    const { registerHandler } = useKeyboardStore.getState();
    
    // Quick add shortcut (Ctrl/Cmd + N)
    const unregisterQuickAdd = registerHandler('quickAdd', () => {
      toggleQuickAddRef.current();
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
      }).catch(() => {
        // Still render Layout even if settings fail — degrade gracefully
        setSettingsReady(true);
        const store = useFavoritesStore.getState();
        store.loadFavorites();
        store.loadRecents();
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
    return <LoginView />;
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
      <EnrollmentView onComplete={() => setNeedsEnrollment(false)} />
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
      <WorkspaceManagementView 
        onWorkspaceSelected={() => {
          setShowWorkspaceManager(false);
          refetchWorkspaces();
        }}
        showClose={!hasNoWorkspaces && !hasNoActiveWorkspace}
        onClose={() => setShowWorkspaceManager(false)}
      />
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
    <ErrorBoundary>
      <Layout />
    </ErrorBoundary>
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
            <AppContent />
            <NotificationToast />
          </DndProvider>
        </KeyboardShortcutsProvider>
      </QueryClientProvider>
    </>
  );
}

export default App;
