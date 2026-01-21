/**
 * DatabaseSwitcher Component
 * 
 * Dropdown at the top of the sidebar showing current database,
 * sync status, and ability to switch or add databases.
 */
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Icon from '@mdi/react';
import { mdiFolder, mdiFolderOpen, mdiSync, mdiAlertCircleOutline, mdiWifiOff, mdiChevronDown, mdiPlus, mdiCog } from '@mdi/js';
import { listDatabases, switchDatabase } from '@/api/databases';
import { useNodesStore, useFavoritesStore } from '@/stores';
import { Dropdown, type DropdownOption } from './core/Dropdown';
import './DatabaseSwitcher.css';

interface DatabaseSwitcherProps {
  onAddDatabase: () => void;
}

type SyncStatus = 'synced' | 'syncing' | 'error' | 'offline';

export function DatabaseSwitcher({ onAddDatabase }: DatabaseSwitcherProps) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('synced');
  const queryClient = useQueryClient();
  const { setShowDbManagement } = useNodesStore();

  const { data, isLoading } = useQuery({
    queryKey: ['databases'],
    queryFn: listDatabases,
    staleTime: 30000,
  });

  const switchMutation = useMutation({
    mutationFn: switchDatabase,
    onSuccess: () => {
      const currentState = useNodesStore.getState();
      
      // Reset node state to prevent showing stale data from previous database
      useNodesStore.setState({
        currentNodeId: null,
        activeNode: null,
        activeNodeId: null,
        sidebarNode: null,
        localGraphNodeId: null,
      });
      
      // Refresh favorites store to load new database's data
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
      
      // Invalidate all data queries
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      queryClient.invalidateQueries({ queryKey: ['nodes'] });
      queryClient.invalidateQueries({ queryKey: ['graph'] });
      queryClient.invalidateQueries({ queryKey: ['assets'] });
      queryClient.invalidateQueries({ queryKey: ['properties'] });
      queryClient.invalidateQueries({ queryKey: ['property-nodes'] });
      queryClient.invalidateQueries({ queryKey: ['page'] });
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
          <span className="db-switcher__sync-icon db-switcher__sync-icon--syncing" title="Syncing">
            <Icon path={mdiSync} size={0.6} spin />
          </span>
        );
      case 'error':
        return (
          <span className="db-switcher__sync-icon db-switcher__sync-icon--error" title="Sync error">
            <Icon path={mdiAlertCircleOutline} size={0.6} />
          </span>
        );
      case 'offline':
        return (
          <span className="db-switcher__sync-icon db-switcher__sync-icon--offline" title="Offline">
            <Icon path={mdiWifiOff} size={0.6} />
          </span>
        );
      default:
        // No icon for synced state
        return null;
    }
  };

  // Build dropdown options from databases
  const dbOptions: DropdownOption<string>[] = data?.databases.map(db => ({
    value: db.name,
    label: db.name,
    icon: db.name === data.active ? mdiFolderOpen : mdiFolder,
  })) || [];

  // Add separator options for actions
  const actionOptions: DropdownOption<string>[] = [
    { value: '__add__', label: 'Add Database', icon: mdiPlus },
    { value: '__manage__', label: 'Manage Databases', icon: mdiCog },
  ];

  const allOptions = [
    ...dbOptions,
    ...(dbOptions.length > 0 ? [{ value: '__divider__', label: '─────────', disabled: true }] : []),
    ...actionOptions,
  ];

  const handleChange = (value: string | null) => {
    if (value === '__add__') {
      onAddDatabase();
    } else if (value === '__manage__') {
      setShowDbManagement(true);
    } else if (value && !value.startsWith('__')) {
      handleSwitch(value);
    }
  };

  const displayName = isLoading 
    ? 'Loading...' 
    : (data?.active || 'No Database');

  return (
    <div className="db-switcher">
      <Dropdown
        options={allOptions}
        value={data?.active || null}
        onChange={handleChange}
        placeholder="Select database..."
        disabled={isLoading}
        size="md"
        className="db-switcher__dropdown"
        renderTrigger={({ isOpen }) => (
          <div className={`db-switcher__trigger ${isOpen ? 'db-switcher__trigger--open' : ''}`}>
            <div className="db-switcher__current">
              <span className="db-switcher__name">{displayName}</span>
            </div>
            <div className="db-switcher__status">
              {getSyncIcon()}
              <Icon path={mdiChevronDown} size={0.7} className="db-switcher__chevron" />
            </div>
          </div>
        )}
      />
    </div>
  );
}

export default DatabaseSwitcher;
