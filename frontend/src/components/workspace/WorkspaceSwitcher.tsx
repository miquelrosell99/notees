/**
 * WorkspaceSwitcher Component
 * 
 * Searchable dropdown for switching between graphs (workspaces).
 * Has a plus button to the right for graph creation.
 */
import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { listWorkspaces, switchWorkspace } from '@/api/workspaces';
import { useNavigationStore, useModalStore, useFavoritesStore } from '@/stores';
import { Button } from '@/components/core/Button';
import { Dropdown, type DropdownOption } from '@/components/core/Dropdown';
import './WorkspaceSwitcher.css';
import { Icon } from '@/components/core/icons';

export function WorkspaceSwitcher() {
  const queryClient = useQueryClient();
  const { setShowWorkspaceManager } = useModalStore();

  const { data } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => listWorkspaces(),
    staleTime: 30000,
    select: (d) => ({
      workspaces: d.items,
      active: d.items.find((w) => w.is_active)?.uuid ?? null,
    }),
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

  const workspaces = data?.workspaces;

  // Convert workspaces to dropdown options
  const options: DropdownOption<string>[] = useMemo(() => {
    if (!workspaces) return [];
    return workspaces.map(w => ({
      value: w.uuid,
      label: w.name,
      icon: "mdi mdi-database-outline",
    }));
  }, [workspaces]);

  const handleChange = useCallback((value: string | null) => {
    if (!value || value === data?.active || switchMutation.isPending) return;
    switchMutation.mutate(value);
  }, [data?.active, switchMutation]);

  // Custom option renderer  
  const renderOption = useCallback((option: DropdownOption<string>, isSelected: boolean) => (
    <>
      <Icon path={"mdi mdi-database-outline"} size={0.6} className="workspace-switcher__item-icon" />
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
          disabled={switchMutation.isPending}
          renderOption={renderOption}
          footer={
            <button
              className="workspace-switcher__manage-btn"
              onClick={() => setShowWorkspaceManager(true)}
            >
              <Icon path={"mdi mdi-view-dashboard"} size={0.6} />
              <span>Workspaces</span>
            </button>
          }
          className="workspace-switcher__dropdown"
        />
        <Button
          className="workspace-switcher__search-btn"
          onClick={() => useModalStore.getState().setCommandPaletteOpen(true)}
          title="Search"
          icon={"mdi mdi-magnify"}
          iconOnly
          size="sm"
          variant="ghost"
        />
      </div>
    </div>
  );
}
