/**
 * DatabaseManagementView Component
 * 
 * Fullscreen view for managing graphs. Shown when user has no graphs
 * or accessed through settings. Allows creating, importing, and managing graphs.
 * 
 * Note: Create, rename, and import functionality requires implementing modal components.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack:react-query';
import { 
  listDatabases, 
  switchDatabase,
  deleteDatabase,
  getDatabaseExportUrl,
  type DatabaseInfo,
} from '@/api/databases';
import { useAuthStore, useNodesStore, useFavoritesStore } from '@/stores';
import { 
  ArrowRightIcon,
  CheckIcon, 
  CloseIcon, 
  DeleteIcon,
} from '../components/icons';
import Icon from '@mdi/react';
import { mdiExport } from '@mdi/js';
import { Button } from '../components/core/Button';
import { Card } from '../components/core/Card';
import './DatabaseManagementView.css';

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
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
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
                ? 'Welcome! Create your first graph'
                : 'Your Graphs'
              }
            </h2>
            <p className="db-management__subtitle">
              {hasNoDatabases
                ? 'A graph stores all your notes and pages. Get started by creating one.'
                : 'Select a graph to open, or create a new one.'
              }
            </p>
          </div>

          {/* Database list */}
          {isLoading ? (
            <div className="db-management__loading">
              <div className="db-management__spinner" />
              <span>Loading graphs...</span>
            </div>
          ) : databases.length > 0 ? (
            <div className="db-management__grid">
              {databases.map((db) => (
                <Card 
                  key={db.name} 
                  className={`db-management__card ${db.name === data?.active ? 'db-management__card--active' : ''} ${deleteConfirm === db.name ? 'db-management__card--delete-confirm' : ''}`}
                  elevation="low"
                  padding={false}
                  interactive
                  selected={db.name === data?.active}
                >
                  <div className="db-management__card-header">
                    <div className="db-management__card-title">
                      <span className="db-management__card-name">{db.name}</span>
                      {db.name === data?.active && (
                        <span className="db-management__card-badge">Active</span>
                      )}
                    </div>
                    <div className="db-management__card-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleExport(db.name)}
                        title="Export"
                      >
                        <Icon path={mdiExport} size={0.7} />
                      </Button>
                      {deleteConfirm === db.name ? (
                        <>
                          <Button
                            variant="danger"
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
                          variant="danger"
                          size="sm"
                          onClick={() => setDeleteConfirm(db.name)}
                          title="Delete"
                          className="db-management__delete-btn"
                        >
                          <DeleteIcon size="sm" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSelectDatabase(db)}
                        title="Open graph"
                      >
                        <ArrowRightIcon size="sm" />
                      </Button>
                    </div>
                  </div>
                  <div className="db-management__card-content">
                    <div className="db-management__card-meta">
                      <span>Created {formatDate(db.created_at)}</span>
                      <span>Modified {formatRelativeTime(db.updated_at)}</span>
                    </div>
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
    </div>
  );
}

export default DatabaseManagementView;
