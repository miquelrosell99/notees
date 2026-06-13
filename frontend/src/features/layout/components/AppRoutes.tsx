/**
 * AppRoutes — react-router-dom route tree.
 *
 * Replaces the bespoke custom router with declarative routes while keeping
 * the existing navigationStore tab model.
 */
import React, { Suspense, useEffect, useState } from 'react';
import {
  Routes,
  Route,
  Outlet,
  Navigate,
  useNavigate,
  useLocation,
} from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore, useModalStore } from '@/stores';
import { COMMAND_IDS } from '@/stores/commandRegistry';
import { useCommand } from '@/hooks/useCommand';
import { getAuthStatus } from '@/features/auth/api/auth';
import { listWorkspaces } from '@/features/workspace/api/workspaces';
import { getSettings } from '@/features/workspace/api/workspaces';
import { settingsKeys } from '@/hooks/queryKeys';
import { getAuthToken, getUserData } from '@/utils/auth';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import type { User } from '@/types';

const Layout = React.lazy(() => import('./Layout').then((m) => ({ default: m.Layout })));
const LoginView = React.lazy(() => import('@/features/auth/pages/LoginView').then((m) => ({ default: m.LoginView })));
const WorkspaceManagementView = React.lazy(() => import('@/features/workspace/pages/WorkspaceManagementView').then((m) => ({ default: m.WorkspaceManagementView })));
const EnrollmentView = React.lazy(() => import('@/features/auth/pages/EnrollmentView').then((m) => ({ default: m.EnrollmentView })));
const InviteAcceptView = React.lazy(() => import('@/features/auth/pages/InviteAcceptView').then((m) => ({ default: m.InviteAcceptView })));
const PublicShareView = React.lazy(() => import('@/features/shares/pages/PublicShareView').then((m) => ({ default: m.PublicShareView })));
const OnboardingView = React.lazy(() => import('@/features/auth/pages/OnboardingView').then((m) => ({ default: m.OnboardingView })));
const QuickAddModal = React.lazy(() => import('./QuickAddModal').then((m) => ({ default: m.QuickAddModal })));

function OnboardingRoute() {
  const navigate = useNavigate();
  return (
    <Suspense fallback={<LoadingScreen label="Loading…" />}>
      <OnboardingView onComplete={() => navigate('/auth', { replace: true })} />
    </Suspense>
  );
}

function LoginRoute() {
  const { isAuthenticated } = useAuthStore();
  const { data: authStatus } = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: () => getAuthStatus(),
    staleTime: Infinity,
  });

  if (authStatus?.needs_onboarding) {
    return <Navigate to="/onboarding" replace />;
  }

  if (isAuthenticated) {
    const intendedUrl = sessionStorage.getItem('intendedUrl');
    sessionStorage.removeItem('intendedUrl');
    return <Navigate to={intendedUrl || '/'} replace />;
  }

  return (
    <Suspense fallback={<LoadingScreen label="Loading…" />}>
      <LoginView registrationEnabled={authStatus?.registration_enabled ?? false} />
    </Suspense>
  );
}

function WorkspaceRedirect() {
  const navigate = useNavigate();
  const { data: dbData, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => listWorkspaces(),
    staleTime: 10000,
    select: (data) => ({
      workspaces: data.items,
      active: data.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });

  useEffect(() => {
    if (dbData?.active) {
      navigate(`/${dbData.active}`, { replace: true });
    } else if (dbData && !dbData.active) {
      navigate('/workspaces', { replace: true });
    }
  }, [dbData, navigate]);

  if (isLoading) {
    return <LoadingScreen label="Loading workspace…" />;
  }

  return null;
}

function AuthenticatedShell() {
  const { isAuthenticated, setUser } = useAuthStore();
  const { showWorkspaceManager, setShowWorkspaceManager } = useModalStore();
  const location = useLocation();
  const navigate = useNavigate();
  const isWorkspacesRoute = location.pathname === '/workspaces';
  const queryClient = useQueryClient();
  const [authRestored, setAuthRestored] = useState(false);
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);

  useCommand(COMMAND_IDS.QUICK_ADD, () => {
    setIsQuickAddOpen((prev) => !prev);
  }, { enabled: isAuthenticated, label: 'Open Quick Add' });

  // Restore persisted auth token/user into the store on first mount.
  useEffect(() => {
    const token = getAuthToken();
    const user = getUserData();
    if (token && user) {
      setUser(user as User);
    }
    setAuthRestored(true);
  }, [setUser]);

  const { data: authStatus, isLoading: isLoadingAuthStatus } = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: () => getAuthStatus(),
    enabled: authRestored,
    staleTime: Infinity,
  });

  const needsOnboarding = authStatus?.needs_onboarding ?? false;

  const { data: dbData, isLoading: isLoadingWorkspaces } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => listWorkspaces(),
    enabled: isAuthenticated && !needsOnboarding,
    staleTime: 10000,
    select: (data) => ({
      workspaces: data.items,
      active: data.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });

  const { data: enrollmentSettings, isLoading: isCheckingEnrollment } = useQuery({
    queryKey: settingsKeys.all,
    queryFn: () => getSettings(),
    enabled: isAuthenticated && !needsOnboarding,
    staleTime: Infinity,
  });

  const needsEnrollment = enrollmentSettings
    ? String(enrollmentSettings['enrollment_completed']) !== 'true'
    : false;

  // Store the intended URL before redirecting an unauthenticated user to /auth.
  useEffect(() => {
    if (
      !isAuthenticated &&
      !needsOnboarding &&
      location.pathname !== '/auth' &&
      location.pathname !== '/enroll' &&
      !location.pathname.startsWith('/s/') &&
      location.pathname !== '/'
    ) {
      sessionStorage.setItem('intendedUrl', location.pathname + location.search);
    }
  }, [isAuthenticated, needsOnboarding, location]);

  // Keep the workspace manager and the URL in sync. When the manager is opened
  // from inside a workspace, push /workspaces so the URL no longer shows the
  // old workspace UUID. Closing it returns to the active workspace.
  useEffect(() => {
    if (!dbData) return;
    const active = dbData.active;
    if (showWorkspaceManager && active && !isWorkspacesRoute) {
      navigate('/workspaces', { replace: true });
    } else if (!showWorkspaceManager && isWorkspacesRoute && active) {
      navigate(`/${active}`, { replace: true });
    } else if (!active && !isWorkspacesRoute) {
      navigate('/workspaces', { replace: true });
    }
  }, [showWorkspaceManager, dbData, isWorkspacesRoute, navigate]);

  // If the user navigates away from /workspaces via the browser back/forward
  // buttons, make sure the modal flag is cleared so the UI stays consistent.
  useEffect(() => {
    if (!isWorkspacesRoute && showWorkspaceManager) {
      setShowWorkspaceManager(false);
    }
  }, [isWorkspacesRoute, showWorkspaceManager, setShowWorkspaceManager]);

  if (!authRestored || isLoadingAuthStatus) {
    return <LoadingScreen label="Loading…" />;
  }

  if (needsOnboarding) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <OnboardingView
          onComplete={() => queryClient.invalidateQueries({ queryKey: ['auth', 'status'] })}
        />
      </Suspense>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/auth" replace />;
  }

  if (isLoadingWorkspaces && !showWorkspaceManager) {
    return <LoadingScreen label="Loading workspace…" />;
  }

  const hasNoWorkspaces = !dbData?.workspaces || dbData.workspaces.length === 0;
  const hasNoActiveWorkspace = !dbData?.active;

  if (hasNoWorkspaces || hasNoActiveWorkspace || isWorkspacesRoute || showWorkspaceManager) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <WorkspaceManagementView
          onWorkspaceSelected={() => {
            setShowWorkspaceManager(false);
            queryClient.invalidateQueries({ queryKey: ['workspaces'] });
          }}
          showClose={!hasNoWorkspaces && !hasNoActiveWorkspace}
          onClose={() => setShowWorkspaceManager(false)}
        />
      </Suspense>
    );
  }

  if (isCheckingEnrollment) {
    return <LoadingScreen label="Loading…" />;
  }

  if (needsEnrollment) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <EnrollmentView
          onComplete={() => queryClient.invalidateQueries({ queryKey: settingsKeys.all })}
        />
      </Suspense>
    );
  }

  return (
    <>
      <Outlet />
      <Suspense fallback={null}>
        <QuickAddModal isOpen={isQuickAddOpen} onClose={() => setIsQuickAddOpen(false)} />
      </Suspense>
    </>
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<LoadingScreen label="Loading…" />}>
      <Routes>
        <Route path="/enroll" element={<InviteAcceptView />} />
        <Route path="/s/:shareUuid" element={<PublicShareView />} />
        <Route path="/onboarding" element={<OnboardingRoute />} />
        <Route path="/auth" element={<LoginRoute />} />
        <Route element={<AuthenticatedShell />}>
          <Route path="/" element={<WorkspaceRedirect />} />
          <Route path="/workspaces" element={<Outlet />} />
          <Route path="/:workspaceId/*" element={<Layout />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
