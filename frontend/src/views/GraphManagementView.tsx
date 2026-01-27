/**
 * GraphManagementView Component
 * 
 * Fullscreen view for managing graphs. Shown when user has no graphs
 * or accessed through settings. Allows creating, importing, and managing graphs.
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
import { useAuthStore, useNodesStore, useFavoritesStore } from '@/stores';
import { GraphModal } from '../components/graphs/GraphModal';
import { ImportOptionsModal } from '../components/graphs/ImportOptionsModal';
import { GraphNameModal } from '../components/graphs/GraphNameModal';
import { 
  ArrowRightIcon,
  CheckIcon, 
  CloseIcon, 
  DeleteIcon,
  EditIcon,
} from '../components/icons';
import Icon from '@mdi/react';
import { mdiExport } from '@mdi/js';
import { Button } from '../components/core/Button';
import { Card } from '../components/core/Card';
import './GraphManagementView.css';

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

interface GraphManagementViewProps {
  /** Called when a graph is selected/activated */
  onGraphSelected?: () => void;
  /** Whether to show the back/close button */
  showClose?: boolean;
  /** Called when close is clicked */
  onClose?: () => void;
}

export function GraphManagementView({ 
  onGraphSelected, 
  showClose = false,
  onClose,
}: GraphManagementViewProps) {
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
    graphName: string | null;
  }>({ isOpen: false, graphName: null });
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
      
      // Clear favorites/recents immediately, then refresh to get new database data
      useFavoritesStore.getState().clear();
      useFavoritesStore.getState().refresh();
      
      // Navigate to home (no database in URL)
      window.history.replaceState(null, '', '/');
      
      // Remove all cached data from previous database to prevent stale icons/data
      // Using removeQueries instead of invalidateQueries clears the cache immediately
      queryClient.removeQueries({ queryKey: ['nodes'] });
      queryClient.removeQueries({ queryKey: ['graph'] });
      queryClient.removeQueries({ queryKey: ['assets'] });
      queryClient.removeQueries({ queryKey: ['properties'] });
      queryClient.removeQueries({ queryKey: ['property-nodes'] });
      queryClient.removeQueries({ queryKey: ['page'] });
      
      // Invalidate databases query to refetch the list (keep cache for smoother UX)
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      onGraphSelected?.();
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
      console.error('Failed to delete graph:', err.message);
      setDeleteConfirm(null);
    },
  });

  // Rename mutation
  const renameMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) => 
      renameDatabase(oldName, newName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      setRenameModalState({ isOpen: false, graphName: null });
      setRenameError(null);
    },
    onError: (err: Error) => {
      setRenameError(err.message || 'Failed to rename graph');
    },
  });

  // Import mutation
  const importMutation = useMutation({
    mutationFn: ({ name, file }: { name: string; file: File }) => importDatabase(name, file),
    onSuccess: async (newGraph) => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      setImportNameModalState({ isOpen: false, file: null, type: null });
      setImportError(null);
      // Auto-switch to the new graph
      await switchMutation.mutateAsync(newGraph.name);
      onGraphSelected?.();
    },
    onError: (err: Error) => {
      setImportError(err.message || 'Failed to import graph');
    },
  });

  // Handle successful graph creation from modal
  const handleGraphCreated = async (newGraph: DatabaseInfo) => {
    // Auto-switch to the new graph
    await switchMutation.mutateAsync(newGraph.name);
    setIsCreateModalOpen(false);
    onGraphSelected?.();
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
  const handleOpenRename = (graphName: string) => {
    setRenameError(null);
    setRenameModalState({ isOpen: true, graphName });
  };

  // Handle rename submission
  const handleRenameSubmit = (newName: string) => {
    if (renameModalState.graphName) {
      renameMutation.mutate({ oldName: renameModalState.graphName, newName });
    }
  };

  // Handle rename modal close
  const handleRenameModalClose = () => {
    setRenameModalState({ isOpen: false, graphName: null });
    setRenameError(null);
  };

  const handleSelectGraph = (graph: DatabaseInfo) => {
    if (graph.name !== data?.active) {
      switchMutation.mutate(graph.name);
    } else {
      onGraphSelected?.();
    }
  };

  const handleExport = (name: string) => {
    window.open(getDatabaseExportUrl(name), '_blank');
  };

  const graphs = data?.databases || [];
  const hasNoGraphs = !isLoading && graphs.length === 0;

  return (
    <div className="db-management">
      <div className="graph-management__container">
        {/* Header */}
        <header className="graph-management__header">
          <div className="graph-management__header-content">
            <div className="graph-management__logo">
              <h1 className="graph-management__title">Notees</h1>
            </div>
            {showClose && onClose && (
              <Button className="graph-management__close" variant="ghost" size="sm" onClick={onClose}>
                ← Back to app
              </Button>
            )}
          </div>
          <div className="graph-management__user-info">
            <span className="graph-management__username">{user?.username}</span>
            <Button className="graph-management__logout" variant="ghost" size="sm" onClick={logout}>
              Logout
            </Button>
          </div>
        </header>

        {/* Main Content */}
        <main className="graph-management__main">
          <div className="graph-management__welcome">
            <h2>
              {hasNoGraphs 
                ? 'Welcome! Create your first graph'
                : 'Your Graphs'
              }
            </h2>
            <p className="graph-management__subtitle">
              {hasNoGraphs
                ? 'A graph stores all your notes and pages. Get started by creating one.'
                : 'Select a graph to open, or create a new one.'
              }
            </p>
          </div>

          {/* Action buttons */}
          <div className="graph-management__actions">
            <Button 
              className="graph-management__action-btn"
              variant="primary"
              size="md"
              onClick={() => setIsCreateModalOpen(true)}
            >
              Create New Graph
            </Button>
            <Button 
              className="graph-management__action-btn"
              variant="default"
              size="md"
              onClick={() => setIsImportOptionsOpen(true)}
            >
              Import Graph
            </Button>
          </div>

          {/* Database list */}
          {isLoading ? (
            <div className="graph-management__loading">
              <div className="graph-management__spinner" />
              <span>Loading graphs...</span>
            </div>
          ) : graphs.length > 0 ? (
            <div className="graph-management__grid">
              {graphs.map((graph) => (
                <Card 
                  key={graph.name} 
                  className={`graph-management__card ${graph.name === data?.active ? 'graph-management__card--active' : ''} ${deleteConfirm === graph.name ? 'graph-management__card--delete-confirm' : ''}`}
                  elevation="low"
                  padding={false}
                  interactive
                  selected={graph.name === data?.active}
                >
                  <div className="graph-management__card-header">
                    <div className="graph-management__card-title">
                      <span className="graph-management__card-name">{graph.name}</span>
                      {graph.name === data?.active && (
                        <span className="graph-management__card-badge">Active</span>
                      )}
                    </div>
                    <div className="graph-management__card-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleOpenRename(graph.name)}
                        title="Rename"
                      >
                        <EditIcon size="sm" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleExport(graph.name)}
                        title="Export"
                      >
                        <Icon path={mdiExport} size={0.7} />
                      </Button>
                      {deleteConfirm === graph.name ? (
                        <>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => deleteMutation.mutate(graph.name)}
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
                          onClick={() => setDeleteConfirm(graph.name)}
                          title="Delete"
                          className="graph-management__delete-btn"
                        >
                          <DeleteIcon size="sm" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSelectGraph(graph)}
                        title="Open graph"
                      >
                        <ArrowRightIcon size="sm" />
                      </Button>
                    </div>
                  </div>
                  <div className="graph-management__card-content">
                    <div className="graph-management__card-meta">
                      <span>Created {formatDate(graph.created_at)}</span>
                      <span>Modified {formatRelativeTime(graph.updated_at)}</span>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : null}
        </main>

        {/* Footer */}
        <footer className="graph-management__footer">
          <p>Notees — Your personal knowledge graph</p>
        </footer>
      </div>

      {/* Create Graph Modal */}
      <GraphModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleGraphCreated}
      />

      {/* Import Options Modal */}
      <ImportOptionsModal
        isOpen={isImportOptionsOpen}
        onClose={() => setIsImportOptionsOpen(false)}
        onSelectOption={handleImportOptionSelected}
      />

      {/* Import Name Modal */}
      <GraphNameModal
        isOpen={importNameModalState.isOpen}
        onClose={handleImportNameModalClose}
        onSubmit={handleImportNameSubmit}
        title={importNameModalState.type === 'zip' 
          ? 'Name Your Imported Graph' 
          : 'Name Your Imported Graph'
        }
        submitLabel="Import Graph"
        isLoading={importMutation.isPending}
        error={importError}
      />

      {/* Rename Graph Modal */}
      <GraphNameModal
        isOpen={renameModalState.isOpen}
        onClose={handleRenameModalClose}
        onSubmit={handleRenameSubmit}
        title={`Rename "${renameModalState.graphName}"`}
        submitLabel="Rename Graph"
        isLoading={renameMutation.isPending}
        error={renameError}
      />
    </div>
  );
}

export default GraphManagementView;
