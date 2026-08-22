/**
 * AppRoutes — react-router-dom route tree.
 *
 * Replaces the bespoke custom router with declarative routes while keeping
 * the existing navigationStore tab model.
 */
import React, { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Routes,
  Route,
  Outlet,
  Navigate,
  useNavigate,
  useLocation,
  useParams,
} from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useAuthStore,
  useModalStore,
  useNavigationStore,
  useSettingsStore,
  DATE_FORMAT_OPTIONS,
  type ThemePreference,
  type AccentColor,
  type DateFormat,
  type DefaultView,
  type QuickAddDestination,
  type FirstDayOfWeek,
  type HashtagPasteMode,
  type TreeEditMode,
} from '@/stores';
import { COMMAND_IDS } from '@/stores/commandRegistry';
import { useCommand } from '@/hooks/useCommand';
import { useAuthStatus, getMe, getLocalWorkspaceUuid } from '@/features/auth';
import { listWorkspaces, getSettings, type WorkspaceInfo } from '@/features/workspace';
import { AdoptionPrompt } from '@/features/workspace/components/AdoptionPrompt';
import { authKeys, settingsKeys, workspaceKeys } from '@/hooks/queryKeys';
import { useConnectionMode } from '@/stores/connectionStore';
import { getUserData } from '@/utils/auth';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { useDelayedOverlay } from '@/hooks/useDelayedOverlay';
import type { User } from '@/types';
import './AppRoutes.css';

const Layout = React.lazy(() => import('./Layout').then((m) => ({ default: m.Layout })));
const LoginView = React.lazy(() => import('@/features/auth/pages/LoginView').then((m) => ({ default: m.LoginView })));
import { WorkspaceManagementView } from '@/features/workspace/pages/WorkspaceManagementView';
const EnrollmentView = React.lazy(() => import('@/features/auth/pages/EnrollmentView').then((m) => ({ default: m.EnrollmentView })));
const InviteAcceptView = React.lazy(() => import('@/features/auth/pages/InviteAcceptView').then((m) => ({ default: m.InviteAcceptView })));
const PublicShareView = React.lazy(() => import('@/features/shares/pages/PublicShareView').then((m) => ({ default: m.PublicShareView })));
const OnboardingView = React.lazy(() => import('@/features/auth/pages/OnboardingView').then((m) => ({ default: m.OnboardingView })));
const QuickAddModal = React.lazy(() => import('./QuickAddModal').then((m) => ({ default: m.QuickAddModal })));

/**
 * Apply user settings returned by the backend so the local Zustand store (and
 * therefore localStorage) stays in sync with the server-side source of truth.
 * This is especially important for settings like `default_view` that affect
 * startup routing.
 */
function syncUserSettingsFromBackend(settings: Record<string, unknown>) {
  const state = useSettingsStore.getState();

  if (typeof settings.oled_mode === 'boolean') {
    state.setOledMode(settings.oled_mode);
  }

  const validThemes: ThemePreference[] = ['light', 'dark', 'system'];
  if (typeof settings.theme === 'string' && validThemes.includes(settings.theme as ThemePreference)) {
    state.setTheme(settings.theme as ThemePreference);
  }

  if (typeof settings.custom_accent_hex === 'string') {
    state.setCustomAccentHex(settings.custom_accent_hex);
  }

  const validAccents: AccentColor[] = ['monochrome', 'sage', 'teal', 'rose', 'navy', 'custom'];
  if (typeof settings.accent_color === 'string' && validAccents.includes(settings.accent_color as AccentColor)) {
    state.setAccentColor(settings.accent_color as AccentColor);
  }

  const validDateFormats = DATE_FORMAT_OPTIONS.map((o) => o.value);
  if (typeof settings.date_format === 'string' && validDateFormats.includes(settings.date_format as DateFormat)) {
    state.setDateFormat(settings.date_format as DateFormat);
  }

  const validDefaultViews: DefaultView[] = ['journal', 'all-pages', 'graph', 'today'];
  if (typeof settings.default_view === 'string' && validDefaultViews.includes(settings.default_view as DefaultView)) {
    state.setDefaultView(settings.default_view as DefaultView);
  }

  const validQuickAddDestinations: QuickAddDestination[] = ['inbox', 'today'];
  if (
    typeof settings.quick_add_destination === 'string' &&
    validQuickAddDestinations.includes(settings.quick_add_destination as QuickAddDestination)
  ) {
    state.setQuickAddDestination(settings.quick_add_destination as QuickAddDestination);
  }

  const validFirstDayOfWeek: FirstDayOfWeek[] = [0, 1, 6];
  if (
    typeof settings.first_day_of_week === 'number' &&
    validFirstDayOfWeek.includes(settings.first_day_of_week as FirstDayOfWeek)
  ) {
    state.setFirstDayOfWeek(settings.first_day_of_week as FirstDayOfWeek);
  }

  if (typeof settings.linked_refs_collapse_level === 'number') {
    state.setLinkedRefsCollapseLevel(settings.linked_refs_collapse_level);
  }

  const validHashtagPasteModes: HashtagPasteMode[] = ['inline-tag', 'inline-class'];
  if (
    typeof settings.hashtag_paste_mode === 'string' &&
    validHashtagPasteModes.includes(settings.hashtag_paste_mode as HashtagPasteMode)
  ) {
    state.setHashtagPasteMode(settings.hashtag_paste_mode as HashtagPasteMode);
  }

  const validTreeEditModes: TreeEditMode[] = ['direct', 'logical'];
  if (
    typeof settings.tree_edit_mode === 'string' &&
    validTreeEditModes.includes(settings.tree_edit_mode as TreeEditMode)
  ) {
    state.setTreeEditMode(settings.tree_edit_mode as TreeEditMode);
  }
}

function NodeRedirect() {
  const { nodeUuid } = useParams<{ nodeUuid: string }>();
  const navigate = useNavigate();
  const openNode = useNavigationStore((s) => s.openNode);

  useLayoutEffect(() => {
    if (nodeUuid) {
      openNode(nodeUuid);
    }
    navigate('/', { replace: true });
  }, [nodeUuid, navigate, openNode]);

  return null;
}

function OnboardingRoute() {
  const navigate = useNavigate();
  return (
    <Suspense fallback={<LoadingScreen label="Loading…" />}>
      <OnboardingView onComplete={() => navigate('/auth', { replace: true })} />
    </Suspense>
  );
}

function LoginRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const connectionMode = useConnectionMode();
  // Local mode has no server; skip the auth-status call so the login screen
  // never touches `/api/*`.
  const { data: authStatus } = useAuthStatus({ enabled: connectionMode !== 'local' });

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
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const isLocalSession = user?.isLocal === true;
  const {
    data: dbData,
    isLoading,
    isError,
  } = useQuery({
    queryKey: workspaceKeys.all,
    queryFn: () => listWorkspaces(),
    staleTime: 10000,
    enabled: isAuthenticated && !isLocalSession,
    select: (data) => ({
      workspaces: data.items,
      active: data.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });

  useEffect(() => {
    // Local sessions own a single well-known workspace; route to it directly
    // without calling listWorkspaces.
    if (isLocalSession) {
      navigate(`/${getLocalWorkspaceUuid()}`, { replace: true });
      return;
    }
    if (dbData?.active) {
      navigate(`/${dbData.active}`, { replace: true });
    } else if (dbData && !dbData.active) {
      navigate('/workspaces', { replace: true });
    } else if (isError) {
      navigate('/workspaces', { replace: true });
    }
  }, [isLocalSession, dbData, isError, navigate]);

  if (isLoading) {
    return <LoadingScreen label="Loading workspace…" />;
  }

  return null;
}

function AuthenticatedShell() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const authVerified = useAuthStore((s) => s.authVerified);
  const setAuthVerified = useAuthStore((s) => s.setAuthVerified);
  const setUser = useAuthStore((s) => s.setUser);
  const user = useAuthStore((s) => s.user);
  // Local sessions are self-verified and own a single well-known workspace;
  // every server round-trip in the guard chain below is skipped for them.
  const isLocalSession = user?.isLocal === true;
  const showWorkspaceManager = useModalStore((s) => s.showWorkspaceManager);
  const setShowWorkspaceManager = useModalStore((s) => s.setShowWorkspaceManager);
  const location = useLocation();
  const navigate = useNavigate();
  const isWorkspacesRoute = location.pathname === '/workspaces';
  const queryClient = useQueryClient();
  const [authRestored, setAuthRestored] = useState(false);
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [settingsSynced, setSettingsSynced] = useState(false);

  useCommand(COMMAND_IDS.QUICK_ADD, () => {
    setIsQuickAddOpen((prev) => !prev);
  }, { enabled: isAuthenticated, label: 'Open Quick Add' });

  // Restore persisted user into the store on first mount. The access token
  // is stored in an HTTPOnly cookie, so we only need to restore the profile.
  useEffect(() => {
    const storedUser = getUserData();
    if (storedUser) {
      setUser(storedUser as User);
      // Local sessions carry no token; mark them verified without /auth/me.
      if ((storedUser as User).isLocal) {
        setAuthVerified(true);
      }
    }
    setAuthRestored(true);
  }, [setUser, setAuthVerified]);

  const { data: authStatus, isLoading: isLoadingAuthStatus } = useAuthStatus({
    enabled: authRestored && !isLocalSession,
  });



  const needsOnboarding = authStatus?.needs_onboarding ?? false;

  // Verify the access token on every mount of the authenticated shell. This
  // catches expired/stolen sessions, triggers the refresh flow when needed, and
  // is the canonical signal that authenticated routes can render. We no longer
  // rely on /auth/status's boolean field for logout decisions because it can
  // race with post-login state updates.
  const { data: verifiedUser, isLoading: isVerifyingAuth } = useQuery({
    queryKey: authKeys.verify(),
    queryFn: () => getMe(),
    enabled: isAuthenticated && authRestored && !isLocalSession,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: false,
  });

  useEffect(() => {
    if (verifiedUser) {
      setAuthVerified(true);
    }
  }, [verifiedUser, setAuthVerified]);

  const { data: serverDbData, isLoading: isLoadingWorkspaces } = useQuery({
    queryKey: workspaceKeys.all,
    queryFn: () => listWorkspaces(),
    enabled: isAuthenticated && !needsOnboarding && authVerified && !isLocalSession,
    staleTime: 10000,
    select: (data) => ({
      workspaces: data.items,
      active: data.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });

  // Local sessions short-circuit the workspace list to their well-known local
  // workspace so downstream gates (and the workspace-manager sync effect) keep
  // working unchanged.
  const dbData = useMemo(() => {
    if (!isLocalSession) return serverDbData;
    const uuid = getLocalWorkspaceUuid();
    const localWorkspace: WorkspaceInfo = { uuid, name: 'Local', is_active: true };
    return { workspaces: [localWorkspace], active: uuid };
  }, [isLocalSession, serverDbData]);

  const { data: enrollmentSettings, isLoading: isCheckingEnrollment } = useQuery({
    queryKey: settingsKeys.all,
    queryFn: () => getSettings(),
    enabled: isAuthenticated && !needsOnboarding && authVerified && !isLocalSession,
    staleTime: Infinity,
  });

  // Sync server-stored user settings into the local Zustand store before the
  // workspace shell renders, so startup routing respects the backend source of
  // truth (e.g. `default_view`). Local mode has no server settings: the
  // client-persisted settings store (with its defaults) is the source of truth.
  useLayoutEffect(() => {
    if (isLocalSession) {
      if (!settingsSynced) setSettingsSynced(true);
      return;
    }
    if (!enrollmentSettings || settingsSynced) return;
    syncUserSettingsFromBackend(enrollmentSettings);
    setSettingsSynced(true);
  }, [isLocalSession, enrollmentSettings, settingsSynced]);

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
  // Only clear on a transition *from* /workspaces to somewhere else; this
  // avoids fighting the sync effect above while the manager is opening.
  const wasWorkspacesRouteRef = useRef(isWorkspacesRoute);
  useEffect(() => {
    if (wasWorkspacesRouteRef.current && !isWorkspacesRoute && showWorkspaceManager) {
      setShowWorkspaceManager(false);
    }
    wasWorkspacesRouteRef.current = isWorkspacesRoute;
  }, [isWorkspacesRoute, showWorkspaceManager, setShowWorkspaceManager]);

  if (!authRestored || isLoadingAuthStatus || isVerifyingAuth) {
    return <LoadingScreen label="Loading…" />;
  }

  if (needsOnboarding) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <OnboardingView
          onComplete={() => queryClient.invalidateQueries({ queryKey: authKeys.status() })}
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
      <>
        <WorkspaceManagementView
          onWorkspaceSelected={() => {
            setShowWorkspaceManager(false);
            queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
          }}
        />
        <AdoptionPrompt />
      </>
    );
  }

  if (isCheckingEnrollment || !settingsSynced) {
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
      <AdoptionPrompt />
      <Suspense fallback={null}>
        <QuickAddModal isOpen={isQuickAddOpen} onClose={() => setIsQuickAddOpen(false)} />
      </Suspense>
    </>
  );
}

export function AppRoutes() {
  const isSwitchingWorkspace = useNavigationStore((state) => state.isSwitchingWorkspace);
  const { isRendered, isVisible } = useDelayedOverlay(
    isSwitchingWorkspace,
    150,   // don't show for switches under 150 ms
    200,   // fade-out duration
  );

  return (
    <>
      <Suspense fallback={<LoadingScreen label="Loading…" />}>
        <Routes>
          <Route path="/enroll" element={<InviteAcceptView />} />
          <Route path="/s/:shareUuid" element={<PublicShareView />} />
          <Route path="/onboarding" element={<OnboardingRoute />} />
          <Route path="/auth" element={<LoginRoute />} />
          <Route element={<AuthenticatedShell />}>
            <Route path="/" element={<WorkspaceRedirect />} />
            <Route path="/workspaces" element={<Outlet />} />
            <Route path="/node/:nodeId" element={<NodeRedirect />} />
            <Route path="/:workspaceId/*" element={<Layout />} />
          </Route>
        </Routes>
      </Suspense>
      {isRendered && (
        <LoadingScreen
          label="Switching workspace…"
          className={`workspace-switch-overlay ${isVisible ? 'workspace-switch-overlay--visible' : ''}`}
        />
      )}
    </>
  );
}
