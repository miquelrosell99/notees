/**
 * WorkspaceSwitcher Component
 * 
 * Searchable dropdown for switching between graphs (workspaces).
 * Has a plus button to the right for graph creation.
 */
import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Icon from '@mdi/react';
import { mdiPlus, mdiDatabaseOutline } from '@mdi/js';
import { listWorkspaces, switchWorkspace } from '@/api/workspaces';
import { useAppStore, useFavoritesStore } from '@/stores';
import { Button } from '../core/Button';
import { Dropdown, type DropdownOption } from '../core/Dropdown';
import './WorkspaceSwitcher.css';

interface WorkspaceSwitcherProps {
  onAddWorkspace: () => void;
}

export function WorkspaceSwitcher({ onAddWorkspace }: WorkspaceSwitcherProps) {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['workspaces'],
    queryFn: listWorkspaces,
    staleTime: 30000,
  });

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
