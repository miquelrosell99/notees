/**
 * WorkspaceManagementView Component
 * 
 * Fullscreen view for managing workspaces. Shown when user has no workspaces
 * or accessed through settings. Allows creating, importing, and managing workspaces.
 */
import { useState, useRef } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  listWorkspaces, 
  switchWorkspace,
  deleteWorkspace,
  renameWorkspace,
  restoreWorkspace,
  type WorkspaceInfo,
} from '@/features/workspace/api/workspaces';
import { useAuthStore, useNavigationStore, useModalStore } from '@/stores';
import { WorkspaceModal } from '@/features/workspace/components/WorkspaceModal';
import { ImportOptionsModal, type ImportResult } from '@/features/workspace/components/ImportOptionsModal';
import { ImportLogseqModal } from '@/features/workspace/components/ImportLogseqModal';

import { WorkspaceNameModal } from '@/features/workspace/components/WorkspaceNameModal';
import { WorkspaceActionsMenu } from '@/features/workspace/components/WorkspaceActionsMenu';
import { WorkspaceShareModal } from '@/features/workspace/components/WorkspaceShareModal';
import { WorkspaceExportModal } from '@/features/workspace/components/WorkspaceExportModal';
import { UserSettingsModal, SystemSettingsModal } from '@/features/layout/components/Modals';


import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { formatDate, formatRelativeTime } from '@/utils/dateFormat';
import { favoriteKeys, recentKeys } from '@/hooks/queryKeys';
import './WorkspaceManagementView.css';

interface WorkspaceManagementViewProps {
  /** Called when a workspace is selected/activated */
  onWorkspaceSelected?: () => void;
  /** Whether to show the back/close button */
  showClose?: boolean;
  /** Called when close is clicked */
  onClose?: () => void;
}

export function WorkspaceManagementView({ 
  onWorkspaceSelected, 
  showClose = false,
  onClose,
}: WorkspaceManagementViewProps) {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isImportOptionsOpen, setIsImportOptionsOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null); // stores uuid
  const [renameModalState, setRenameModalState] = useState<{
    isOpen: boolean;
    workspaceName: string | null;
  }>({ isOpen: false, workspaceName: null });
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isUserSettingsOpen, setIsUserSettingsOpen] = useState(false);
  const [isSystemSettingsOpen, setIsSystemSettingsOpen] = useState(false);
  const [restoreState, setRestoreState] = useState<{
    confirming: string | null; // workspace uuid being confirmed
    file: File | null;
  }>({ confirming: null, file: null });
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [shareModalState, setShareModalState] = useState<{
    isOpen: boolean;
    workspaceUuid: string | null;
  }>({ isOpen: false, workspaceUuid: null });
  const [exportModalState, setExportModalState] = useState<{
    isOpen: boolean;
    workspaceUuid: string | null;
    workspaceName: string;
  }>({ isOpen: false, workspaceUuid: null, workspaceName: '' });
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const restoreTargetRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const { logout, user } = useAuthStore();
  const { isImportLogseqModalOpen, setImportLogseqModalOpen } = useModalStore();

  // Fetch workspaces
  const { data, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => listWorkspaces(),
    staleTime: 10000,
    select: (d) => ({
      workspaces: d.items,
      active: d.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });

  // Switch database mutation
  const switchMutation = useMutation({
    mutationFn: switchWorkspace,
    onSuccess: (_data, switchedUuid) => {
      // Reset node state to prevent showing stale data from previous database
      useNavigationStore.setState({
        currentNodeId: null,
        activeNodeId: null,
        sidebarNode: null,
        localGraphNodeId: null,
        mainViewType: 'node',
      });
      
      // Clear favorites/recents so stale data from the previous workspace is not shown
      queryClient.removeQueries({ queryKey: favoriteKeys.all });
      queryClient.removeQueries({ queryKey: recentKeys.all });
      
      // Navigate to new workspace home
      window.history.replaceState(null, '', `/${switchedUuid}`);
      
      // Clear ALL cached data to prevent any stale data from previous workspace
      queryClient.clear();
      onWorkspaceSelected?.();
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: deleteWorkspace,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setDeleteConfirm(null);
    },
    onError: (err: Error) => {
      console.error('Failed to delete workspace:', err.message);
      setDeleteConfirm(null);
    },
  });

  // Rename mutation
  const renameMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) => 
      renameWorkspace(oldName, newName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      setRenameModalState({ isOpen: false, workspaceName: null });
      setRenameError(null);
    },
    onError: (err: Error) => {
      setRenameError(err.message || 'Failed to rename workspace');
    },
  });

  // Restore mutation
  const restoreMutation = useMutation({
    mutationFn: ({ uuid, file }: { uuid: string; file: File }) => restoreWorkspace(uuid, file),
    onSuccess: () => {
      // Clear ALL cached data since workspace content has changed
      queryClient.clear();
      setRestoreState({ confirming: null, file: null });
      setRestoreError(null);
    },
    onError: (err: Error) => {
      setRestoreError(err.message || 'Failed to restore workspace');
      setRestoreState({ confirming: null, file: null });
    },
  });

  // Handle successful workspace creation from modal
  const handleWorkspaceCreated = async (newWorkspace: WorkspaceInfo) => {
    // Auto-switch to the new workspace
    await switchMutation.mutateAsync(newWorkspace.uuid);
    setIsCreateModalOpen(false);
    onWorkspaceSelected?.();
  };

  // Handle successful import from the unified ImportOptionsModal
  // Note: logseq-edn and logseq-sqlite are handled entirely inside ImportOptionsModal
  // (workspace switch + import pipeline + report), so they never reach this handler.
  const handleImportSuccess = async ({ workspace, type }: ImportResult) => {
    if (type === 'markdown') {
      setIsImportOptionsOpen(false);
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      useModalStore.getState().setImportMarkdownModalOpen(true);
      await switchMutation.mutateAsync(workspace.uuid);
      onWorkspaceSelected?.();
    } else {
      // JSON — already fully imported by the API call; just switch and navigate
      setIsImportOptionsOpen(false);
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      await switchMutation.mutateAsync(workspace.uuid);
      onWorkspaceSelected?.();
    }
  };

  // Handle rename modal open
  const handleOpenRename = (workspaceName: string) => {
    setRenameError(null);
    setRenameModalState({ isOpen: true, workspaceName });
  };

  // Handle rename submission
  const handleRenameSubmit = (newName: string) => {
    if (renameModalState.workspaceName) {
      renameMutation.mutate({ oldName: renameModalState.workspaceName, newName });
    }
  };

  // Handle rename modal close
  const handleRenameModalClose = () => {
    setRenameModalState({ isOpen: false, workspaceName: null });
    setRenameError(null);
  };

  const handleSelectWorkspace = (workspace: WorkspaceInfo) => {
    if (switchMutation.isPending) return;
    if (workspace.uuid !== data?.active) {
      switchMutation.mutate(workspace.uuid);
    } else {
      onWorkspaceSelected?.();
    }
  };

  const handleExport = (workspace: WorkspaceInfo) => {
    setExportModalState({
      isOpen: true,
      workspaceUuid: workspace.uuid,
      workspaceName: workspace.name,
    });
  };

  // Handle restore: open file picker for a specific workspace
  const handleRestoreClick = (workspaceUuid: string) => {
    restoreTargetRef.current = workspaceUuid;
    restoreInputRef.current?.click();
  };

  // Handle restore file selection
  const handleRestoreFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const uuid = restoreTargetRef.current;
    if (file && uuid) {
      setRestoreState({ confirming: uuid, file });
      setRestoreError(null);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  // Confirm restore
  const handleRestoreConfirm = () => {
    if (restoreState.confirming && restoreState.file) {
      restoreMutation.mutate({ uuid: restoreState.confirming, file: restoreState.file });
    }
  };

  // Cancel restore
  const handleRestoreCancel = () => {
    setRestoreState({ confirming: null, file: null });
    setRestoreError(null);
  };

  const workspaces = data?.workspaces || [];
  const hasNoWorkspaces = !isLoading && workspaces.length === 0;

  return (
    <div className="db-management">
      <div className="workspace-management__container">
        {/* Header */}
        <header className="workspace-management__header">
          <div className="workspace-management__header-content">
            <div className="workspace-management__logo">
              <h1 className="workspace-management__title">Notees</h1>
            </div>
            {showClose && onClose && (
              <Button className="workspace-management__close" variant="ghost" size="sm" onClick={onClose}>
                ÔåÉ Back to app
              </Button>
            )}
          </div>
          <div className="workspace-management__user-info">
            <span className="workspace-management__username">{user?.email}</span>
            <Button aria-label="User Settings"
              className="workspace-management__user-settings"
              variant="ghost"
              size="sm"
              icon={"mdi mdi-cog-outline"}
              onClick={() => setIsUserSettingsOpen(true)}
              title="User Settings"
            />
            {user?.role === 'admin' && (
              <Button aria-label="System Settings"
                className="workspace-management__system-settings"
                variant="ghost"
                size="sm"
                icon={"mdi mdi-account-cog"}
                onClick={() => setIsSystemSettingsOpen(true)}
                title="System Settings"
              />
            )}
            <Button className="workspace-management__logout" variant="ghost" size="sm" onClick={logout}>
              Logout
            </Button>
          </div>
        </header>

        {/* Main Content */}
        <main className="workspace-management__main">
          <div className="workspace-management__welcome">
            <h2>
              {hasNoWorkspaces 
                ? 'Welcome! Create your first workspace'
                : 'Your Workspaces'
              }
            </h2>
            <p className="workspace-management__subtitle">
              {hasNoWorkspaces
                ? 'A workspace stores all your notes and pages. Get started by creating one.'
                : 'Select a workspace to open, or create a new one.'
              }
            </p>
          </div>

          {/* Action buttons */}
          <div className="workspace-management__actions">
            <Button 
              className="workspace-management__action-btn"
              variant="primary"
              size="md"
              onClick={() => setIsCreateModalOpen(true)}
            >
              Create New Workspace
            </Button>
            <Button 
              className="workspace-management__action-btn"
              variant="default"
              size="md"
              onClick={() => setIsImportOptionsOpen(true)}
            >
              Import Workspace
            </Button>
          </div>

          {/* Database list */}
          {isLoading ? (
            <div className="workspace-management__loading">
              <Spinner size="lg" label="Loading workspaces..." centered />
            </div>
          ) : workspaces.length > 0 ? (
            <div className="workspace-management__grid">
              {workspaces.map((workspace) => (
                <Card 
                  key={workspace.uuid} 
                  className={`workspace-management__card ${workspace.uuid === data?.active ? 'workspace-management__card--active' : ''} ${deleteConfirm === workspace.uuid ? 'workspace-management__card--delete-confirm' : ''}`}
                  elevation="low"
                  padding={false}
                  selected={workspace.uuid === data?.active}
                >
                  <div className="workspace-management__card-header">
                    <div className="workspace-management__card-title">
                      <span className="workspace-management__card-name">{workspace.name}</span>
                      <div className="workspace-management__card-badges">
                        {workspace.uuid === data?.active && (
                          <span className="workspace-management__card-badge">Active</span>
                        )}
                        {workspace.is_shared && (
                          <span className="workspace-management__card-badge workspace-management__card-badge--shared">Shared</span>
                        )}
                      </div>
                    </div>
                    <div className="workspace-management__card-actions">
                      <Button aria-label="Open workspace"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSelectWorkspace(workspace)}
                        title="Open workspace"
                        className="workspace-management__access-btn"
                        disabled={switchMutation.isPending}
                        icon="mdi mdi-arrow-right"
                      />
                      {deleteConfirm === workspace.uuid && (
                        <>
                          <Button aria-label="Confirm delete"
                            variant="danger"
                            size="sm"
                            onClick={() => deleteMutation.mutate(workspace.uuid)}
                            title="Confirm delete"
                            disabled={deleteMutation.isPending}
                            icon="mdi mdi-check"
                          />
                          <Button aria-label="Cancel"
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteConfirm(null)}
                            title="Cancel"
                            disabled={deleteMutation.isPending}
                            icon="mdi mdi-close"
                          />
                        </>
                      )}
                      {deleteConfirm !== workspace.uuid && (
                        <WorkspaceActionsMenu
                          workspace={workspace}
                          onRename={(w) => handleOpenRename(w.name)}
                          onExport={handleExport}
                          onRestore={handleRestoreClick}
                          onShare={(w) => setShareModalState({ isOpen: true, workspaceUuid: w.uuid })}
                          onDelete={(uuid) => setDeleteConfirm(uuid)}
                          disabled={restoreMutation.isPending}
                        />
                      )}
                    </div>
                  </div>
                  <div className="workspace-management__card-content">
                    {restoreState.confirming === workspace.uuid && (
                      <div className="workspace-management__restore-confirm">
                        <span className="workspace-management__restore-warn">
                          Restore from <strong>{restoreState.file?.name}</strong>? This will replace ALL data in this workspace.
                        </span>
                        {restoreError && (
                          <span className="workspace-management__restore-error">{restoreError}</span>
                        )}
                        <div className="workspace-management__restore-actions">
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={handleRestoreConfirm}
                            disabled={restoreMutation.isPending}
                          >
                            {restoreMutation.isPending ? 'Restoring...' : 'Confirm Restore'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleRestoreCancel}
                            disabled={restoreMutation.isPending}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="workspace-management__card-meta">
                      <span>Created {formatDate(workspace.created_at)}</span>
                      <span>Modified {formatRelativeTime(workspace.updated_at)}</span>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : null}
        </main>

        {/* Footer */}
        <footer className="workspace-management__footer">
          <p>Notees - Your personal knowledge base</p>
        </footer>

        {/* Hidden file input for restore */}
        <input
          ref={restoreInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleRestoreFileSelected}
        />
      </div>

      {/* Create Workspace Modal */}
      <WorkspaceModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleWorkspaceCreated}
      />

      {/* Import Workspace Modal (unified) */}
      <ImportOptionsModal
        isOpen={isImportOptionsOpen}
        onClose={() => setIsImportOptionsOpen(false)}
        onSuccess={handleImportSuccess}
        onFinish={onWorkspaceSelected}
      />

      {/* Rename Workspace Modal */}
      <WorkspaceNameModal
        isOpen={renameModalState.isOpen}
        onClose={handleRenameModalClose}
        onSubmit={handleRenameSubmit}
        title={`Rename "${renameModalState.workspaceName}"`}
        submitLabel="Rename Workspace"
        isLoading={renameMutation.isPending}
        error={renameError}
      />

      {/* User Settings Modal */}
      <UserSettingsModal
        isOpen={isUserSettingsOpen}
        onClose={() => setIsUserSettingsOpen(false)}
      />

      {/* System Settings Modal */}
      <SystemSettingsModal
        isOpen={isSystemSettingsOpen}
        onClose={() => setIsSystemSettingsOpen(false)}
      />

      {/* Logseq Import Modal – rendered here so it's available before Layout mounts */}
      <ImportLogseqModal
        isOpen={isImportLogseqModalOpen}
        onClose={() => setImportLogseqModalOpen(false)}
      />

      {/* Workspace Export Modal */}
      {exportModalState.workspaceUuid && (
        <WorkspaceExportModal
          isOpen={exportModalState.isOpen}
          onClose={() => setExportModalState({ isOpen: false, workspaceUuid: null, workspaceName: '' })}
          workspaceUuid={exportModalState.workspaceUuid}
          workspaceName={exportModalState.workspaceName}
        />
      )}

      {/* Workspace Share Modal */}
      {shareModalState.workspaceUuid && (
        <WorkspaceShareModal
          workspaceUuid={shareModalState.workspaceUuid}
          isOpen={shareModalState.isOpen}
          onClose={() => setShareModalState({ isOpen: false, workspaceUuid: null })}
        />
      )}

      {/* Switching overlay – locks the interface during workspace switch */}
      {switchMutation.isPending && (
        <div className="workspace-management__switching-overlay" aria-live="assertive" role="status">
          <div className="workspace-management__switching-box">
            <Spinner size="lg" label="Switching workspace…" />
          </div>
        </div>
      )}

      {/* Deleting overlay – locks the interface during workspace deletion */}
      {deleteMutation.isPending && (
        <div className="workspace-management__deleting-overlay" aria-live="assertive" role="status">
          <div className="workspace-management__deleting-box">
            <Spinner size="lg" label="Deleting workspace…" />
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkspaceManagementView;