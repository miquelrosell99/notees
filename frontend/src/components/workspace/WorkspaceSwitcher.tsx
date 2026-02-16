/**
 * WorkspaceSwitcher Component
 * 
 * Searchable dropdown for switching between graphs (workspaces).
 * Typing a non-existing name prompts the user to create a new graph.
 * Has a plus button to the right for quick graph creation.
 */
import { useState, useRef, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Icon from '@mdi/react';
import { mdiChevronDown, mdiPlus, mdiDatabaseOutline } from '@mdi/js';
import { listWorkspaces, switchWorkspace, createWorkspace, type WorkspaceInfo } from '@/api/workspaces';
import { useAppStore, useFavoritesStore } from '@/stores';
import { Card } from '../core/Card';
import { useClickOutside } from '@/hooks/useClickOutside';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import './WorkspaceSwitcher.css';

interface WorkspaceSwitcherProps {
  onAddWorkspace: () => void;
}

export function WorkspaceSwitcher({ onAddWorkspace }: WorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
    staleTime: 30000,
  });

  useClickOutside(containerRef, () => { setIsOpen(false); setSearchQuery(''); });
  useEscapeKey(() => { setIsOpen(false); setSearchQuery(''); });

  const clearCacheOnSwitch = useCallback(() => {
    const currentState = useAppStore.getState();
    useAppStore.setState({
      currentNodeId: null,
      activeNode: null,
      activeNodeId: null,
      sidebarNode: null,
      localGraphNodeId: null,
    });
    useFavoritesStore.getState().clear();
    useFavoritesStore.getState().refresh();
    const viewPath = currentState.mainViewType === 'node' ? '' :
      currentState.mainViewType === 'all-pages' ? 'pages' :
      currentState.mainViewType === 'journals' ? 'journal' :
      currentState.mainViewType === 'graph' ? 'graph' :
      currentState.mainViewType === 'archived' ? 'archived' :
      currentState.mainViewType === 'assets' ? 'assets' : '';
    const newUrl = viewPath ? `/${viewPath}` : '/';
    window.history.replaceState(null, '', newUrl);
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
    queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  }, [queryClient]);

  const switchMutation = useMutation({
    mutationFn: switchWorkspace,
    onSuccess: () => {
      clearCacheOnSwitch();
      setIsOpen(false);
      setSearchQuery('');
    },
  });

  const createMutation = useMutation({
    mutationFn: createWorkspace,
    onSuccess: async (newWorkspace: WorkspaceInfo) => {
      await switchMutation.mutateAsync(newWorkspace.uuid);
    },
  });

  const filteredWorkspaces = useMemo(() => {
    if (!data?.workspaces) return [];
    if (!searchQuery.trim()) return data.workspaces;
    const q = searchQuery.toLowerCase();
    return data.workspaces.filter(w => w.name.toLowerCase().includes(q));
  }, [data?.workspaces, searchQuery]);

  const showCreateOption = useMemo(() => {
    if (!searchQuery.trim()) return false;
    const q = searchQuery.trim().toLowerCase();
    return !data?.workspaces?.some(w => w.name.toLowerCase() === q);
  }, [searchQuery, data?.workspaces]);

  const totalItems = filteredWorkspaces.length + (showCreateOption ? 1 : 0);

  const handleSelect = (workspace: WorkspaceInfo) => {
    if (workspace.uuid !== data?.active) {
      switchMutation.mutate(workspace.uuid);
    } else {
      setIsOpen(false);
      setSearchQuery('');
    }
  };

  const handleCreate = () => {
    const name = searchQuery.trim();
    if (name) {
      createMutation.mutate(name);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, totalItems - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (showCreateOption && selectedIndex === filteredWorkspaces.length) {
        handleCreate();
      } else if (filteredWorkspaces[selectedIndex]) {
        handleSelect(filteredWorkspaces[selectedIndex]);
      }
    }
  };

  const handleToggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    setSearchQuery('');
    setSelectedIndex(0);
    if (next) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const activeWorkspace = data?.workspaces.find(w => w.uuid === data?.active);
  const displayName = isLoading ? 'Loading...' : (activeWorkspace?.name || 'No Graph');

  return (
    <div className="workspace-switcher" ref={containerRef}>
      <div className="workspace-switcher__row">
        <button
          className={`workspace-switcher__trigger ${isOpen ? 'workspace-switcher__trigger--open' : ''}`}
          onClick={handleToggle}
        >
          <div className="workspace-switcher__current">
            <Icon path={mdiDatabaseOutline} size={0.7} className="workspace-switcher__graph-icon" />
            <span className="workspace-switcher__name">{displayName}</span>
          </div>
          <Icon path={mdiChevronDown} size={0.7} className="workspace-switcher__chevron" />
        </button>
        <button
          className="workspace-switcher__add-btn"
          onClick={() => onAddWorkspace()}
          title="Create new graph"
        >
          <Icon path={mdiPlus} size={0.7} />
        </button>
      </div>

      {isOpen && (
        <Card className="workspace-switcher__popup" elevation="high" padding={false}>
          <div className="workspace-switcher__search">
            <input
              ref={inputRef}
              type="text"
              className="workspace-switcher__search-input"
              placeholder="Search or create graph..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSelectedIndex(0); }}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          </div>
          <div className="workspace-switcher__list">
            {filteredWorkspaces.map((workspace, index) => (
              <button
                key={workspace.uuid}
                className={`workspace-switcher__item ${workspace.uuid === data?.active ? 'workspace-switcher__item--active' : ''} ${index === selectedIndex ? 'workspace-switcher__item--selected' : ''}`}
                onClick={() => handleSelect(workspace)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <Icon path={mdiDatabaseOutline} size={0.6} className="workspace-switcher__item-icon" />
                <span className="workspace-switcher__item-name">{workspace.name}</span>
                {workspace.uuid === data?.active && (
                  <span className="workspace-switcher__item-badge">Active</span>
                )}
              </button>
            ))}
            {showCreateOption && (
              <button
                className={`workspace-switcher__item workspace-switcher__item--create ${selectedIndex === filteredWorkspaces.length ? 'workspace-switcher__item--selected' : ''}`}
                onClick={handleCreate}
                onMouseEnter={() => setSelectedIndex(filteredWorkspaces.length)}
              >
                <Icon path={mdiPlus} size={0.6} className="workspace-switcher__item-icon" />
                <span className="workspace-switcher__item-name">
                  Create "<strong>{searchQuery.trim()}</strong>"
                </span>
              </button>
            )}
            {filteredWorkspaces.length === 0 && !showCreateOption && (
              <div className="workspace-switcher__empty">No graphs found</div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

export default WorkspaceSwitcher;
