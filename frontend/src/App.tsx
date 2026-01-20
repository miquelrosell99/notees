/**
 * Main application component
 */
import { useEffect } from 'react';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { Layout } from './components/Layout';
import { LoginPage } from './components/LoginPage';
import { DatabaseManagementView } from './views/DatabaseManagementView';
import { listDatabases } from './api/databases';
import { useAuthStore, useNodesStore, useFavoritesStore } from './stores';
import { getLogger } from './utils/logger';
import './App.css';

const log = getLogger('App');

function AppContent() {
  const { isAuthenticated, isLoading, logout } = useAuthStore();
  const { toggleQuickAdd, toggleCalendar, showDbManagement, setShowDbManagement } = useNodesStore();
  
  // Fetch databases when authenticated
  const { data: dbData, isLoading: isLoadingDatabases, refetch: refetchDatabases } = useQuery({
    queryKey: ['databases'],
    queryFn: listDatabases,
    enabled: isAuthenticated,
    staleTime: 10000,
  });
  
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
    const token = localStorage.getItem('token');
    const userStr = localStorage.getItem('user');
    
    if (token && userStr) {
      try {
        const user = JSON.parse(userStr);
        log.debug('Found stored auth, restoring session', { username: user.username });
        useAuthStore.getState().setUser(user);
      } catch (error) {
        log.warn('Failed to parse stored user data, clearing auth');
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    } else {
      log.debug('No valid stored auth found');
      // Clear any partial auth data
      if (token || userStr) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    }
  }, []);
  
  // Global keyboard shortcuts
  useEffect(() => {
    if (!isAuthenticated) return;
    
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+N or Cmd+N: Quick add
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        toggleQuickAdd();
      }
      // Ctrl+Shift+D or Cmd+Shift+D: Open calendar
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        toggleCalendar();
      }
    }
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isAuthenticated, toggleQuickAdd, toggleCalendar]);
  
  // Sync favorites store with current database
  useEffect(() => {
    if (dbData?.active) {
      useFavoritesStore.getState().setCurrentDatabase(dbData.active);
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
    return <LoginPage />;
  }
  
  // Redirect away from /auth when authenticated
  if (window.location.pathname === '/auth') {
    // Restore the intended URL if we have one
    const intendedUrl = sessionStorage.getItem('intendedUrl');
    sessionStorage.removeItem('intendedUrl');
    window.history.replaceState(null, '', intendedUrl || '/');
  }
  
  // Show loading while checking databases
  if (isLoadingDatabases) {
    log.debug('Loading databases...');
    return (
      <div className="loading-screen">
        <div className="loading-spinner">Loading...</div>
      </div>
    );
  }
  
  // Show database management if no databases exist or no active database
  const hasNoDatabases = !dbData?.databases || dbData.databases.length === 0;
  const hasNoActiveDatabase = !dbData?.active;
  
  if (hasNoDatabases || hasNoActiveDatabase || showDbManagement) {
    log.debug('Showing database management view', { hasNoDatabases, hasNoActiveDatabase, showDbManagement });
    return (
      <DatabaseManagementView 
        onDatabaseSelected={() => {
          setShowDbManagement(false);
          refetchDatabases();
        }}
        showClose={!hasNoDatabases && !hasNoActiveDatabase}
        onClose={() => setShowDbManagement(false)}
      />
    );
  }
  
  log.debug('User authenticated, showing main layout');
  return <Layout />;
}

function App() {
  useEffect(() => {
    log.info('Notees application initialized', {
      version: import.meta.env.VITE_APP_VERSION || 'dev',
      mode: import.meta.env.MODE,
    });
  }, []);
  
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}

export default App;
