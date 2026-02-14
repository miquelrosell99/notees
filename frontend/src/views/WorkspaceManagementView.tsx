/**
 * WorkspaceManagementView Component
 * 
 * Fullscreen view for managing workspaces. Shown when user has no workspaces
 * or accessed through settings. Allows creating, importing, and managing workspaces.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  listDatabases, 
  switchDatabase,
  deleteDatabase,
  renameDatabase,
  getDatabaseExportUrl,
  importDatabase,
  type DatabaseInfo,
} from '@/api/databases';
import { useAuthStore, useAppStore, useFavoritesStore } from '@/stores';
import { WorkspaceModal } from '../components/workspace/WorkspaceModal';
import { ImportOptionsModal } from '../components/workspace/ImportOptionsModal';
import { WorkspaceNameModal } from '../components/workspace/WorkspaceNameModal';
import { 
  ArrowRightIcon,
  CheckIcon, 
  CloseIcon, 
  DeleteIcon,
  EditIcon,
} from '../components/core/icons';
import Icon from '@mdi/react';
import { mdiExport } from '@mdi/js';
import { Button } from '../components/core/Button';
import { Card } from '../components/core/Card';
import { formatDate, formatRelativeTime } from '@/utils/dateFormat';
import './WorkspaceManagementView.css';

type ImportType = 'sqlite' | 'zip';

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
  const [importNameModalState, setImportNameModalState] = useState<{
    isOpen: boolean;
    file: File | null;
    type: ImportType | null;
  }>({ isOpen: false, file: null, type: null });
  const [importError, setImportError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [renameModalState, setRenameModalState] = useState<{
    isOpen: boolean;
    workspaceName: string | null;
  }>({ isOpen: false, workspaceName: null });
  const [renameError, setRenameError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { logout, user } = useAuthStore();

  // Fetch databases
  const { data, isLoading } = useQuery({
    queryKey: ['databases'],
    queryFn: listDatabases,
    staleTime: 10000,
  });

  // Switch database mutation
  const switchMutation = useMutation({
    mutationFn: switchDatabase,
    onSuccess: () => {
      // Reset node state to prevent showing stale data from previous database
      useAppStore.setState({
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
      
      // Navigate to home (no database in URL)
      window.history.replaceState(null, '', '/');
      
      // Remove ALL cached data from previous workspace to prevent stale data
      // Using removeQueries instead of invalidateQueries clears the cache immediately
      queryClient.removeQueries({ queryKey: ['nodes'] });
      queryClient.removeQueries({ queryKey: ['graph'] });
      queryClient.removeQueries({ queryKey: ['assets'] });
      queryClient.removeQueries({ queryKey: ['properties'] });
      queryClient.removeQueries({ queryKey: ['property-nodes'] });
      queryClient.removeQueries({ queryKey: ['page'] });
      queryClient.removeQueries({ queryKey: ['trash'] });
      queryClient.removeQueries({ queryKey: ['archived-pages'] });
      queryClient.removeQueries({ queryKey: ['nodeViews'] });
      queryClient.removeQueries({ queryKey: ['inlineClasses'] });
      queryClient.removeQueries({ queryKey: ['textLinks'] });
      
      // Invalidate databases query to refetch the list (keep cache for smoother UX)
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      onWorkspaceSelected?.();
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: deleteDatabase,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
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
      renameDatabase(oldName, newName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      setRenameModalState({ isOpen: false, workspaceName: null });
      setRenameError(null);
    },
    onError: (err: Error) => {
      setRenameError(err.message || 'Failed to rename workspace');
    },
  });

  // Import mutation
  const importMutation = useMutation({
    mutationFn: ({ name, file }: { name: string; file: File }) => importDatabase(name, file),
    onSuccess: async (newWorkspace) => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      setImportNameModalState({ isOpen: false, file: null, type: null });
      setImportError(null);
      // Auto-switch to the new workspace
      await switchMutation.mutateAsync(newWorkspace.name);
      onWorkspaceSelected?.();
    },
    onError: (err: Error) => {
      setImportError(err.message || 'Failed to import workspace');
    },
  });

  // Handle successful workspace creation from modal
  const handleWorkspaceCreated = async (newWorkspace: DatabaseInfo) => {
    // Auto-switch to the new workspace
    await switchMutation.mutateAsync(newWorkspace.name);
    setIsCreateModalOpen(false);
    onWorkspaceSelected?.();
  };

  // Handle import option selection (after file is chosen)
  const handleImportOptionSelected = (type: ImportType, file: File) => {
    setIsImportOptionsOpen(false);
    setImportError(null);
    setImportNameModalState({ isOpen: true, file, type });
  };

  // Handle import name submission
  const handleImportNameSubmit = (name: string) => {
    if (importNameModalState.file) {
      importMutation.mutate({ name, file: importNameModalState.file });
    }
  };

  // Handle import name modal close
  const handleImportNameModalClose = () => {
    setImportNameModalState({ isOpen: false, file: null, type: null });
    setImportError(null);
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

  const handleSelectWorkspace = (workspace: DatabaseInfo) => {
    if (workspace.name !== data?.active) {
      switchMutation.mutate(workspace.name);
    } else {
      onWorkspaceSelected?.();
    }
  };

  const handleExport = (name: string) => {
    window.open(getDatabaseExportUrl(name), '_blank');
  };

  const workspaces = data?.databases || [];
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
            <span className="workspace-management__username">{user?.username}</span>
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
                  key={workspace.name} 
                  className={`workspace-management__card ${workspace.name === data?.active ? 'workspace-management__card--active' : ''} ${deleteConfirm === workspace.name ? 'workspace-management__card--delete-confirm' : ''}`}
                  elevation="low"
                  padding={false}
                  selected={workspace.name === data?.active}
                >
                  <div className="workspace-management__card-header">
                    <div className="workspace-management__card-title">
                      <span className="workspace-management__card-name">{workspace.name}</span>
                      {workspace.name === data?.active && (
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
                        onClick={() => handleExport(workspace.name)}
                        title="Export"
                      >
                        <Icon path={mdiExport} size={0.7} />
                      </Button>
                      {deleteConfirm === workspace.name ? (
                        <>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => deleteMutation.mutate(workspace.name)}
                            title="Confirm delete"
                          >
                            <CheckIcon size="sm" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteConfirm(null)}
                            title="Cancel"
                          >
                            <CloseIcon size="sm" />
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setDeleteConfirm(workspace.name)}
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
          <p>Notees ÔÇö Your personal knowledge base</p>
        </footer>
      </div>

      {/* Create Workspace Modal */}
      <WorkspaceModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleWorkspaceCreated}
      />

      {/* Import Options Modal */}
      <ImportOptionsModal
        isOpen={isImportOptionsOpen}
        onClose={() => setIsImportOptionsOpen(false)}
        onSelectOption={handleImportOptionSelected}
      />

      {/* Import Name Modal */}
      <WorkspaceNameModal
        isOpen={importNameModalState.isOpen}
        onClose={handleImportNameModalClose}
        onSubmit={handleImportNameSubmit}
        title={importNameModalState.type === 'zip' 
          ? 'Name Your Imported Workspace' 
          : 'Name Your Imported Workspace'
        }
        submitLabel="Import Workspace"
        isLoading={importMutation.isPending}
        error={importError}
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
    </div>
  );
}

export default WorkspaceManagementView;