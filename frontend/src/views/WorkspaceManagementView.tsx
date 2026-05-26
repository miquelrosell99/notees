/**
 * WorkspaceManagementView Component
 * 
 * Fullscreen view for managing workspaces. Shown when user has no workspaces
 * or accessed through settings. Allows creating, importing, and managing workspaces.
 */
import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  listWorkspaces, 
  switchWorkspace,
  deleteWorkspace,
  renameWorkspace,
  exportWorkspaceZip,
  restoreWorkspace,
  type WorkspaceInfo,
} from '@/api/workspaces';
import { downloadBlob } from '@/utils/download';
import { useAuthStore, useNavigationStore, useModalStore, useFavoritesStore } from '@/stores';
import { WorkspaceModal } from '../components/workspace/WorkspaceModal';
import { ImportOptionsModal, type ImportResult } from '../components/workspace/ImportOptionsModal';
import { ImportLogseqModal } from '../components/workspace/ImportLogseqModal';

import { WorkspaceNameModal } from '../components/workspace/WorkspaceNameModal';
import { UserSettingsModal, SystemSettingsModal } from '../components/layout/Modals';
import { 
  ArrowRightIcon,
  CheckIcon, 
  CloseIcon, 
  DeleteIcon,
  EditIcon,
} from '../components/core/icons';

import { Button } from '../components/core/Button';
import { Card } from '../components/core/Card';
import { formatDate, formatRelativeTime } from '@/utils/dateFormat';
import './WorkspaceManagementView.css';
import { Icon } from '@/components/core/icons';

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
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const restoreTargetRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const { logout, user } = useAuthStore();
  const { isImportLogseqModalOpen, setImportLogseqModalOpen } = useModalStore();

  // Fetch workspaces
  const { data, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
    staleTime: 10000,
  });

  // Switch database mutation
  const switchMutation = useMutation({
    mutationFn: switchWorkspace,
    onSuccess: (_data, switchedUuid) => {
      // Reset node state to prevent showing stale data from previous database
      useNavigationStore.setState({
        currentNodeId: null,
        activeNode: null,
        activeNodeId: null,
        sidebarNode: null,
        localGraphNodeId: null,
        mainViewType: 'node',
      });
      
      // Clear favorites/recents immediately, then refresh to get new database data
      useFavoritesStore.getState().clear();
      useFavoritesStore.getState().refresh();
      
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
    if (workspace.uuid !== data?.active) {
      switchMutation.mutate(workspace.uuid);
    } else {
      onWorkspaceSelected?.();
    }
  };

  const handleExport = async (workspace: WorkspaceInfo) => {
    try {
      const blob = await exportWorkspaceZip(workspace.uuid);
      downloadBlob(blob, `${workspace.name}_full.zip`);
    } catch (err) {
      console.error('Failed to export workspace:', err);
    }
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
            <Button
              className="workspace-management__user-settings"
              variant="ghost"
              size="sm"
              icon={"mdi mdi-cog-outline"}
              onClick={() => setIsUserSettingsOpen(true)}
              title="User Settings"
            />
            {user?.role === 'admin' && (
              <Button
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
              <div className="workspace-management__spinner" />
              <span>Loading workspaces...</span>
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
                      {workspace.uuid === data?.active && (
                        <span className="workspace-management__card-badge">Active</span>
                      )}
                    </div>
                    <div className="workspace-management__card-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleOpenRename(workspace.name)}
                        title="Rename"
                      >
                        <EditIcon size="sm" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleExport(workspace)}
                        title="Export"
                      >
                        <Icon path={"mdi mdi-export"} size={0.7} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRestoreClick(workspace.uuid)}
                        title="Restore from dump"
                        disabled={restoreMutation.isPending}
                      >
                        <Icon path={"mdi mdi-backup-restore"} size={0.7} />
                      </Button>
                      {deleteConfirm === workspace.uuid ? (
                        <>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => deleteMutation.mutate(workspace.uuid)}
                            title="Confirm delete"
                            disabled={deleteMutation.isPending}
                          >
                            <CheckIcon size="sm" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteConfirm(null)}
                            title="Cancel"
                            disabled={deleteMutation.isPending}
                          >
                            <CloseIcon size="sm" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setDeleteConfirm(workspace.uuid)}
                          title="Delete"
                          className="workspace-management__delete-btn"
                        >
                          <DeleteIcon size="sm" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSelectWorkspace(workspace)}
                        title="Open workspace"
                      >
                        <ArrowRightIcon size="sm" />
                      </Button>
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

      {/* Deleting overlay – locks the interface during workspace deletion */}
      {deleteMutation.isPending && (
        <div className="workspace-management__deleting-overlay" aria-live="assertive" role="status">
          <div className="workspace-management__deleting-box">
            <div className="workspace-management__spinner" />
            <span>Deleting workspace…</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkspaceManagementView;