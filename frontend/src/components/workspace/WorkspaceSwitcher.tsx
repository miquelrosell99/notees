/**
 * WorkspaceSwitcher Component
 * 
 * Dropdown at the top of the sidebar showing current workspace,
 * sync status, and ability to switch or add workspaces.
 */
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Icon from '@mdi/react';
import { mdiSync, mdiAlertCircleOutline, mdiWifiOff, mdiChevronDown, mdiPlus, mdiCog } from '@mdi/js';
import { listWorkspaces, switchWorkspace } from '@/api/workspaces';
import { useAppStore, useFavoritesStore } from '@/stores';
import { Dropdown, type DropdownOption } from '../core/Dropdown';
import './WorkspaceSwitcher.css';

interface WorkspaceSwitcherProps {
  onAddWorkspace: () => void;
}

type SyncStatus = 'synced' | 'syncing' | 'error' | 'offline';

export function WorkspaceSwitcher({ onAddWorkspace }: WorkspaceSwitcherProps) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('synced');
  const queryClient = useQueryClient();
  const { setShowDbManagement } = useAppStore();

  const { data, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
    staleTime: 30000,
  });

  const switchMutation = useMutation({
    mutationFn: switchWorkspace,
    onSuccess: () => {
      const currentState = useAppStore.getState();
      
      // Reset node state to prevent showing stale data from previous workspace
      useAppStore.setState({
        currentNodeId: null,
        activeNode: null,
        activeNodeId: null,
        sidebarNode: null,
        localGraphNodeId: null,
      });
      
      // Clear favorites/recents immediately, then refresh to get new workspace data
      useFavoritesStore.getState().clear();
      useFavoritesStore.getState().refresh();
      
      // Update URL - preserve view type but without database in path
      const viewPath = currentState.mainViewType === 'node' ? '' : 
        currentState.mainViewType === 'all-pages' ? 'pages' :
        currentState.mainViewType === 'journals' ? 'journal' :
        currentState.mainViewType === 'graph' ? 'graph' :
        currentState.mainViewType === 'archived' ? 'archived' :
        currentState.mainViewType === 'assets' ? 'assets' : '';
      
      const newUrl = viewPath ? `/${viewPath}` : '/';
      window.history.replaceState(null, '', newUrl);
      
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
      
      // Invalidate workspaces query to refetch the list (keep cache for smoother UX)
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });

  // Simulate sync status changes (replace with real sync logic)
  useEffect(() => {
    const interval = setInterval(() => {
      // In a real app, this would check actual sync status
      setSyncStatus('synced');
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleSwitch = (value: string | null) => {
    if (value && value !== data?.active) {
      switchMutation.mutate(value);
    }
  };

  const getSyncIcon = () => {
    switch (syncStatus) {
      case 'syncing':
        return (
          <span className="workspace-switcher__sync-icon workspace-switcher__sync-icon--syncing" title="Syncing">
            <Icon path={mdiSync} size={0.6} spin />
          </span>
        );
      case 'error':
        return (
          <span className="workspace-switcher__sync-icon workspace-switcher__sync-icon--error" title="Sync error">
            <Icon path={mdiAlertCircleOutline} size={0.6} />
          </span>
        );
      case 'offline':
        return (
          <span className="workspace-switcher__sync-icon workspace-switcher__sync-icon--offline" title="Offline">
            <Icon path={mdiWifiOff} size={0.6} />
          </span>
        );
      default:
        // No icon for synced state
        return null;
    }
  };

  // Build dropdown options from workspaces (use uuid as value, name as label)
  const workspaceOptions: DropdownOption<string>[] = data?.workspaces.map(workspace => ({
    value: workspace.uuid,
    label: workspace.name,
  })) || [];

  // Add separator options for actions
  const actionOptions: DropdownOption<string>[] = [
    { value: '__add__', label: 'Add Workspace', icon: mdiPlus },
    { value: '__manage__', label: 'Manage Workspaces', icon: mdiCog },
  ];

  const allOptions = [
    ...workspaceOptions,
    ...(workspaceOptions.length > 0 ? [{ value: '__divider__', label: '─────────', disabled: true }] : []),
    ...actionOptions,
  ];

  const handleChange = (value: string | null) => {
    if (value === '__add__') {
      onAddWorkspace();
    } else if (value === '__manage__') {
      setShowDbManagement(true);
    } else if (value && !value.startsWith('__')) {
      handleSwitch(value);
    }
  };

  const activeWorkspace = data?.workspaces.find(w => w.uuid === data?.active);
  const displayName = isLoading 
    ? 'Loading...' 
    : (activeWorkspace?.name || 'No Workspace');

  return (
    <div className="workspace-switcher">
      <Dropdown
        options={allOptions}
        value={data?.active || null}
        onChange={handleChange}
        placeholder="Select workspace..."
        disabled={isLoading}
        size="md"
        className="workspace-switcher__dropdown"
        renderTrigger={({ isOpen }) => (
          <div className={`workspace-switcher__trigger ${isOpen ? 'workspace-switcher__trigger--open' : ''}`}>
            <div className="workspace-switcher__current">
              <span className="workspace-switcher__name">{displayName}</span>
            </div>
            <div className="workspace-switcher__status">
              {getSyncIcon()}
              <Icon path={mdiChevronDown} size={0.7} className="workspace-switcher__chevron" />
            </div>
          </div>
        )}
      />
    </div>
  );
}

export default WorkspaceSwitcher;
