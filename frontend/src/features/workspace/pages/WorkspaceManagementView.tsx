/**
 * WorkspaceManagementView Component
 * 
 * Fullscreen view for managing workspaces. Shown when user has no workspaces
 * or accessed through settings. Allows creating, importing, and managing workspaces.
 */
import { useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Spinner } from '@/components/ui/Spinner';
import { DataStateView } from '@/components/ui/DataStateView';
import { useWorkspaces, useWorkspaceMutations } from '@/features/workspace';
import type { WorkspaceInfo } from '@/features/workspace/api/workspaces';
import { useModalStore } from '@/stores';
import { WorkspaceModal } from '@/features/workspace/components/WorkspaceModal';
import { ImportOptionsModal, type ImportResult } from '@/features/workspace/components/ImportOptionsModal';
import { WorkspaceNameModal } from '@/features/workspace/components/WorkspaceNameModal';
import { WorkspaceActionsMenu } from '@/features/workspace/components/WorkspaceActionsMenu';
import { WorkspaceShareModal } from '@/features/workspace/components/WorkspaceShareModal';
import { WorkspaceExportModal } from '@/features/workspace/components/WorkspaceExportModal';
import { UserSettingsModal, SystemSettingsModal } from '@/features/layout';
import { AccountMenu } from '@/features/layout';


import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { formatDate, formatRelativeTime } from '@/utils/dateFormat';
import { workspaceKeys } from '@/hooks/queryKeys';
import './WorkspaceManagementView.css';

interface WorkspaceManagementViewProps {
  /** Called when a workspace is selected/activated */
  onWorkspaceSelected?: () => void;
}

export function WorkspaceManagementView({ 
  onWorkspaceSelected,
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

  // Fetch workspaces
  const { data, isLoading, error, refetch } = useWorkspaces({
    staleTime: 10000,
    select: (d) => ({
      workspaces: d.items,
      active: d.items.find((w) => w.is_active)?.uuid ?? null,
    }),
  });

  const {
    switchWorkspace: switchMutation,
    deleteWorkspace: deleteMutation,
    renameWorkspace: renameMutation,
    restoreWorkspace: restoreMutation,
  } = useWorkspaceMutations();

  // Handle successful workspace creation from modal
  const handleWorkspaceCreated = async (newWorkspace: WorkspaceInfo) => {
    // Auto-switch to the new workspace
    await switchMutation.mutateAsync(newWorkspace.uuid);
    setIsCreateModalOpen(false);
    onWorkspaceSelected?.();
  };

  // Handle successful import from the unified ImportOptionsModal
  const handleImportSuccess = async ({ workspace, type }: ImportResult) => {
    if (type === 'markdown') {
      setIsImportOptionsOpen(false);
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
      useModalStore.getState().setImportMarkdownModalOpen(true);
      await switchMutation.mutateAsync(workspace.uuid);
      onWorkspaceSelected?.();
    } else {
      // JSON — already fully imported by the API call; just switch and navigate
      setIsImportOptionsOpen(false);
      queryClient.invalidateQueries({ queryKey: workspaceKeys.all });
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
      renameMutation.mutate(
        { oldName: renameModalState.workspaceName, newName },
        {
          onSuccess: () => {
            setRenameModalState({ isOpen: false, workspaceName: null });
            setRenameError(null);
          },
          onError: (err: Error) => {
            setRenameError(err.message || 'Failed to rename workspace');
          },
        }
      );
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
      restoreMutation.mutate(
        { workspaceUuid: restoreState.confirming, file: restoreState.file },
        {
          onSuccess: () => {
            setRestoreState({ confirming: null, file: null });
            setRestoreError(null);
          },
          onError: (err: Error) => {
            setRestoreError(err.message || 'Failed to restore workspace');
            setRestoreState({ confirming: null, file: null });
          },
        }
      );
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
    <div className="workspace-management">
      <div className="workspace-management__container">
        {/* Header */}
        <header className="workspace-management__header">
          <div className="workspace-management__header-content">
            <div className="workspace-management__logo">
              <h1 className="workspace-management__title">Notees</h1>
            </div>
          </div>
          <AccountMenu
            onOpenUserSettings={() => setIsUserSettingsOpen(true)}
            onOpenSystemSettings={() => setIsSystemSettingsOpen(true)}
          />
        </header>

        {/* Main Content */}
        <main className="workspace-management__main">
          <div className="workspace-management__welcome">
            <h2>
              {hasNoWorkspaces 
                ? 'Welcome! Create your first workspace'
                : 'Your workspaces'
              }
            </h2>
            <p className="workspace-management__subtitle">
              {hasNoWorkspaces
                ? 'A workspace holds all your notes and pages. Create one to get started.'
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
          <DataStateView
            isLoading={isLoading}
            error={error}
            onRetry={refetch}
            skeletonRows={4}
          >
            {workspaces.length > 0 && (
              <div className="workspace-management__grid">
                {workspaces.map((workspace) => (
                  <Card 
                    key={workspace.uuid} 
                    className={`workspace-management__card ${workspace.uuid === data?.active ? 'workspace-management__card--active' : ''} ${deleteConfirm === workspace.uuid ? 'workspace-management__card--delete-confirm' : ''}`}
                    elevation="low"
                    padding={false}
                  >
                    <div className="workspace-management__card-header">
                      <div className="workspace-management__card-title">
                        <span className="workspace-management__card-name">{workspace.name}</span>
                        <div className="workspace-management__card-badges">
                          {workspace.is_shared && (
                            <Pill text="Shared" className="workspace-management__pill--shared" />
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
                              hapticIntensity="medium"
                              onClick={() =>
                                deleteMutation.mutate(workspace.uuid, {
                                  onSuccess: () => setDeleteConfirm(null),
                                  onError: () => setDeleteConfirm(null),
                                })
                              }
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
                              hapticIntensity="medium"
                              onClick={handleRestoreConfirm}
                              disabled={restoreMutation.isPending}
                              loading={restoreMutation.isPending}
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
                      <div className="workspace-management__card-footer">
                        <div className="workspace-management__card-meta">
                          <span>Created {formatDate(workspace.created_at)}</span>
                          <span>Modified {formatRelativeTime(workspace.updated_at)}</span>
                        </div>
                        {workspace.uuid === data?.active && (
                          <Pill text="Active" className="workspace-management__pill--active" />
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </DataStateView>
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