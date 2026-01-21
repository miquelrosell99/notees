/**
 * DatabaseManagementView Component
 * 
 * Fullscreen view for managing databases. Shown when user has no databases
 * or accessed through settings. Allows creating, importing, and managing databases.
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
import { useAuthStore, useNodesStore } from '@/stores';
import { DatabaseModal } from '../components/databases/DatabaseModal';
import { ImportOptionsModal } from '../components/ImportOptionsModal';
import { DatabaseNameModal } from '../components/databases/DatabaseNameModal';
import { 
  FolderIcon, 
  FolderOpenIcon, 
  CheckIcon, 
  CloseIcon, 
  DeleteIcon,
  EditIcon,
} from '../components/icons';
import Icon from '@mdi/react';
import { mdiExport } from '@mdi/js';
import { Button } from '../components/core/Button';
import { Card } from '../components/core/Card';
import './DatabaseManagementView.css';

type ImportType = 'sqlite' | 'zip';

/** Format a date string for display */
function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return 'Unknown';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  } catch {
    return 'Unknown';
  }
}

/** Format a relative time string */
function formatRelativeTime(dateStr: string | undefined): string {
  if (!dateStr) return 'Unknown';
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(dateStr);
  } catch {
    return 'Unknown';
  }
}

interface DatabaseManagementViewProps {
  /** Called when a database is selected/activated */
  onDatabaseSelected?: () => void;
  /** Whether to show the back/close button */
  showClose?: boolean;
  /** Called when close is clicked */
  onClose?: () => void;
}

export function DatabaseManagementView({ 
  onDatabaseSelected, 
  showClose = false,
  onClose,
}: DatabaseManagementViewProps) {
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
    dbName: string | null;
  }>({ isOpen: false, dbName: null });
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
      useNodesStore.setState({
        currentNodeId: null,
        activeNode: null,
        activeNodeId: null,
        sidebarNode: null,
        localGraphNodeId: null,
        mainViewType: 'node',
      });
      
      // Navigate to home (no database in URL)
      window.history.replaceState(null, '', '/');
      
      // Invalidate all data queries
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      queryClient.invalidateQueries({ queryKey: ['nodes'] });
      queryClient.invalidateQueries({ queryKey: ['graph'] });
      queryClient.invalidateQueries({ queryKey: ['assets'] });
      queryClient.invalidateQueries({ queryKey: ['properties'] });
      queryClient.invalidateQueries({ queryKey: ['property-nodes'] });
      queryClient.invalidateQueries({ queryKey: ['page'] });
      onDatabaseSelected?.();
    },
  });

  // Delete database mutation
  const deleteMutation = useMutation({
    mutationFn: deleteDatabase,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      setDeleteConfirm(null);
    },
    onError: (err: Error) => {
      console.error('Failed to delete database:', err.message);
      setDeleteConfirm(null);
    },
  });

  // Rename database mutation
  const renameMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) => 
      renameDatabase(oldName, newName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      setRenameModalState({ isOpen: false, dbName: null });
      setRenameError(null);
    },
    onError: (err: Error) => {
      setRenameError(err.message || 'Failed to rename database');
    },
  });

  // Import database mutation
  const importMutation = useMutation({
    mutationFn: ({ name, file }: { name: string; file: File }) => importDatabase(name, file),
    onSuccess: async (newDb) => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      setImportNameModalState({ isOpen: false, file: null, type: null });
      setImportError(null);
      // Auto-switch to the new database
      await switchMutation.mutateAsync(newDb.name);
      onDatabaseSelected?.();
    },
    onError: (err: Error) => {
      setImportError(err.message || 'Failed to import database');
    },
  });

  // Handle successful database creation from modal
  const handleDatabaseCreated = async (newDb: DatabaseInfo) => {
    // Auto-switch to the new database
    await switchMutation.mutateAsync(newDb.name);
    setIsCreateModalOpen(false);
    onDatabaseSelected?.();
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
  const handleOpenRename = (dbName: string) => {
    setRenameError(null);
    setRenameModalState({ isOpen: true, dbName });
  };

  // Handle rename submission
  const handleRenameSubmit = (newName: string) => {
    if (renameModalState.dbName) {
      renameMutation.mutate({ oldName: renameModalState.dbName, newName });
    }
  };

  // Handle rename modal close
  const handleRenameModalClose = () => {
    setRenameModalState({ isOpen: false, dbName: null });
    setRenameError(null);
  };

  const handleSelectDatabase = (db: DatabaseInfo) => {
    if (db.name !== data?.active) {
      switchMutation.mutate(db.name);
    } else {
      onDatabaseSelected?.();
    }
  };

  const handleExport = (name: string) => {
    window.open(getDatabaseExportUrl(name), '_blank');
  };

  const databases = data?.databases || [];
  const hasNoDatabases = !isLoading && databases.length === 0;

  return (
    <div className="db-management">
      <div className="db-management__container">
        {/* Header */}
        <header className="db-management__header">
          <div className="db-management__header-content">
            <div className="db-management__logo">
              <h1 className="db-management__title">Notees</h1>
            </div>
            {showClose && onClose && (
              <Button className="db-management__close" variant="ghost" size="sm" onClick={onClose}>
                ← Back to app
              </Button>
            )}
          </div>
          <div className="db-management__user-info">
            <span className="db-management__username">{user?.username}</span>
            <Button className="db-management__logout" variant="ghost" size="sm" onClick={logout}>
              Logout
            </Button>
          </div>
        </header>

        {/* Main Content */}
        <main className="db-management__main">
          <div className="db-management__welcome">
            <h2>
              {hasNoDatabases 
                ? 'Welcome! Create your first database'
                : 'Your Databases'
              }
            </h2>
            <p className="db-management__subtitle">
              {hasNoDatabases
                ? 'A database stores all your notes, pages, and graphs. Get started by creating one.'
                : 'Select a database to open, or create a new one.'
              }
            </p>
          </div>

          {/* Action buttons */}
          <div className="db-management__actions">
            <Button 
              className="db-management__action-btn"
              variant="primary"
              size="md"
              onClick={() => setIsCreateModalOpen(true)}
            >
              Create New Database
            </Button>
            <Button 
              className="db-management__action-btn"
              variant="default"
              size="md"
              onClick={() => setIsImportOptionsOpen(true)}
            >
              Import Database
            </Button>
          </div>

          {/* Database list */}
          {isLoading ? (
            <div className="db-management__loading">
              <div className="db-management__spinner" />
              <span>Loading databases...</span>
            </div>
          ) : databases.length > 0 ? (
            <div className="db-management__grid">
              {databases.map((db) => (
                <Card 
                  key={db.name} 
                  className={`db-management__card ${db.name === data?.active ? 'db-management__card--active' : ''}`}
                  elevation="low"
                  padding={false}
                  interactive
                  selected={db.name === data?.active}
                >
                  <button
                    className="db-management__card-content"
                    onClick={() => handleSelectDatabase(db)}
                  >
                    <div className="db-management__card-header">
                      <span className="db-management__card-icon">
                        {db.name === data?.active ? <FolderOpenIcon size="lg" /> : <FolderIcon size="lg" />}
                      </span>
                      {db.name === data?.active && (
                        <span className="db-management__card-badge">Active</span>
                      )}
                    </div>
                    <div className="db-management__card-body">
                      <span className="db-management__card-name">{db.name}</span>
                      <div className="db-management__card-stats">
                        {db.page_count !== undefined && (
                          <span>{db.page_count} pages</span>
                        )}
                        {db.node_count !== undefined && (
                          <span>{db.node_count} nodes</span>
                        )}
                      </div>
                    </div>
                    <div className="db-management__card-meta">
                      <span>Created {formatDate(db.created_at)}</span>
                      <span>Modified {formatRelativeTime(db.updated_at)}</span>
                    </div>
                  </button>
                  <div className="db-management__card-footer">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleExport(db.name)}
                      title="Export"
                    >
                      <Icon path={mdiExport} size={0.7} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleOpenRename(db.name)}
                      title="Rename"
                    >
                      <EditIcon size="sm" />
                    </Button>
                    {deleteConfirm === db.name ? (
                      <>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => deleteMutation.mutate(db.name)}
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
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteConfirm(db.name)}
                        title="Delete"
                        className="db-management__delete-btn"
                      >
                        <DeleteIcon size="sm" />
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          ) : null}
        </main>

        {/* Footer */}
        <footer className="db-management__footer">
          <p>Notees — Your personal knowledge graph</p>
        </footer>
      </div>

      {/* Create Database Modal */}
      <DatabaseModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleDatabaseCreated}
      />

      {/* Import Options Modal */}
      <ImportOptionsModal
        isOpen={isImportOptionsOpen}
        onClose={() => setIsImportOptionsOpen(false)}
        onSelectOption={handleImportOptionSelected}
      />

      {/* Import Name Modal */}
      <DatabaseNameModal
        isOpen={importNameModalState.isOpen}
        onClose={handleImportNameModalClose}
        onSubmit={handleImportNameSubmit}
        title={importNameModalState.type === 'zip' 
          ? 'Name Your Imported Database' 
          : 'Name Your Imported Database'
        }
        submitLabel="Import Database"
        isLoading={importMutation.isPending}
        error={importError}
      />

      {/* Rename Database Modal */}
      <DatabaseNameModal
        isOpen={renameModalState.isOpen}
        onClose={handleRenameModalClose}
        onSubmit={handleRenameSubmit}
        title={`Rename "${renameModalState.dbName}"`}
        submitLabel="Rename Database"
        isLoading={renameMutation.isPending}
        error={renameError}
      />
    </div>
  );
}

export default DatabaseManagementView;
