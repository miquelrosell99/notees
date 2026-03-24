/**
 * WorkspaceSwitcher Component
 * 
 * Searchable dropdown for switching between graphs (workspaces).
 * Has a plus button to the right for graph creation.
 */
import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Icon from '@mdi/react';
import { mdiPlus, mdiDatabaseOutline, mdiViewDashboard } from '@mdi/js';
import { listWorkspaces, switchWorkspace } from '@/api/workspaces';
import { useNavigationStore, useModalStore, useFavoritesStore } from '@/stores';
import { Button } from '../core/Button';
import { Dropdown, type DropdownOption } from '../core/Dropdown';
import './WorkspaceSwitcher.css';

interface WorkspaceSwitcherProps {
  onAddWorkspace: () => void;
}

export function WorkspaceSwitcher({ onAddWorkspace }: WorkspaceSwitcherProps) {
  const queryClient = useQueryClient();
  const { setShowWorkspaceManager } = useModalStore();

  const { data } = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
    staleTime: 30000,
  });

  const clearCacheOnSwitch = useCallback((switchedUuid: string) => {
    useNavigationStore.setState({
      currentNodeId: null,
      activeNode: null,
      activeNodeId: null,
      sidebarNode: null,
      localGraphNodeId: null,
      mainViewType: 'node',
    });
    useFavoritesStore.getState().clear();
    useFavoritesStore.getState().refresh();
    
    // Navigate to new workspace home
    window.history.replaceState(null, '', `/${switchedUuid}`);
    
    // Clear ALL cached data to prevent any stale data from previous workspace
    queryClient.clear();
  }, [queryClient]);

  const switchMutation = useMutation({
    mutationFn: switchWorkspace,
    onSuccess: (_data, switchedUuid) => {
      clearCacheOnSwitch(switchedUuid);
    },
  });

  // Convert workspaces to dropdown options
  const options: DropdownOption<string>[] = useMemo(() => {
    if (!data?.workspaces) return [];
    return data.workspaces.map(w => ({
      value: w.uuid,
      label: w.name,
      icon: mdiDatabaseOutline,
    }));
  }, [data?.workspaces]);

  const handleChange = useCallback((value: string | null) => {
    if (!value || value === data?.active) return;
    switchMutation.mutate(value);
  }, [data?.active, switchMutation]);

  // Custom option renderer  
  const renderOption = useCallback((option: DropdownOption<string>, isSelected: boolean) => (
    <>
      <Icon path={mdiDatabaseOutline} size={0.6} className="workspace-switcher__item-icon" />
      <span className="workspace-switcher__item-name">{option.label}</span>
      {isSelected && (
        <span className="workspace-switcher__item-badge">Active</span>
      )}
    </>
  ), []);

  return (
    <div className="workspace-switcher">
      <div className="workspace-switcher__row">
        <Dropdown
          options={options}
          value={data?.active || null}
          onChange={handleChange}
          placeholder="Select graph..."
          searchable
          size="sm"
          renderOption={renderOption}
          searchExtra={
            <Button
              icon={mdiPlus}
              iconOnly
              size="xs"
              variant="ghost"
              title="Create Workspace"
              onClick={onAddWorkspace}
            />
          }
          footer={
            <button
              className="workspace-switcher__manage-btn"
              onClick={() => setShowWorkspaceManager(true)}
            >
              <Icon path={mdiViewDashboard} size={0.6} />
              <span>Workspaces</span>
            </button>
          }
          className="workspace-switcher__dropdown"
        />
        <Button
          className="workspace-switcher__add-btn"
          onClick={() => onAddWorkspace()}
          title="Create new graph"
          icon={mdiPlus}
          iconOnly
          size="sm"
          variant="ghost"
        />
      </div>
    </div>
  );
}

export default WorkspaceSwitcher;
