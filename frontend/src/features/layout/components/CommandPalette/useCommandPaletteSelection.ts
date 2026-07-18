import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types';
import { listNodes } from '@/api/nodes';
import {
  getOrCreateDailyNote,
  getOrCreateMonthlyNote,
  getOrCreateYearlyNote,
} from '@/features/content/hooks/useNodeDateQueries';
import { useNavigationStore } from '@/stores';
import { useCommandRegistry } from '@/stores/commandRegistry';
import { useNotifications } from '@/stores/notificationStore';
import { useCreateNode } from '@/features/content';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { parseHierarchicalPath, resolveHierarchicalParentUuid } from '@/utils/hierarchicalPath';
import type { ItemEntry, DuplicateModalState } from './CommandPalette.types';

interface UseCommandPaletteSelectionParams {
  allItems: ItemEntry[];
  searchTerm: string;
  pageNameForCreation: string;
  selectedClasses: Node[];
  pageClassUuid: string | null | undefined;
  destinationPage: Node | undefined;
  onSelect?: (node: Node) => void;
  onClose: () => void;
  handlePrefixSelect: (prefix: string) => void;
  handleBooleanSelect: (value: boolean) => void;
  setDuplicateModal: (state: DuplicateModalState) => void;
  setMaxPages: (updater: React.SetStateAction<number>) => void;
  setMaxBlocks: (updater: React.SetStateAction<number>) => void;
  setMaxProperties: (updater: React.SetStateAction<number>) => void;
}

export function useCommandPaletteSelection(params: UseCommandPaletteSelectionParams) {
  const {
    allItems,
    searchTerm,
    pageNameForCreation,
    selectedClasses,
    pageClassUuid,
    destinationPage,
    onSelect,
    onClose,
    handlePrefixSelect,
    handleBooleanSelect,
    setDuplicateModal,
    setMaxPages,
    setMaxBlocks,
    setMaxProperties,
  } = params;

  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const openNode = useNavigationStore((s) => s.openNode);
  const openPropertyView = useNavigationStore((s) => s.openPropertyView);
  const { error: notifyError, warning: notifyWarning } = useNotifications();
  const createNodeMutation = useCreateNode();

  const handleSelect = useCallback(async (index: number) => {
    const item = allItems[index];
    if (!item) return;

    switch (item.type) {
      case 'date': {
        const pd = item.parsedDate;
        if (!pd || !workspaceUuid) break;
        const store = getWorkspaceStore(workspaceUuid);
        if (!store) {
          notifyError('Failed to navigate to date', 'Workspace store not available.');
          onClose();
          break;
        }
        try {
          let dateNode: Node;
          if (item.existingNode) {
            dateNode = item.existingNode;
          } else {
            if (pd.type === 'day' && pd.month && pd.day) {
              const dateStr = `${pd.year}-${String(pd.month).padStart(2, '0')}-${String(pd.day).padStart(2, '0')}`;
              dateNode = getOrCreateDailyNote(store, dateStr);
            } else if (pd.type === 'month' && pd.month) {
              dateNode = getOrCreateMonthlyNote(store, pd.year, pd.month);
            } else {
              dateNode = getOrCreateYearlyNote(store, pd.year);
            }
            queryClient.invalidateQueries({ queryKey: nodeKeys.allPages() });
            queryClient.invalidateQueries({ queryKey: nodeKeys.lists() });
            queryClient.invalidateQueries({ queryKey: nodeKeys.dailyList() });
          }
          if (onSelect) {
            onSelect(dateNode);
          } else {
            openNode(dateNode.uuid);
          }
        } catch {
          notifyError('Failed to navigate to date', 'Could not open or create the date page.');
        }
        onClose();
        break;
      }

      case 'page':
      case 'block':
      case 'browse-page':
        if (item.result?.node) {
          if (onSelect) {
            onSelect(item.result.node);
          } else {
            openNode(item.result.node.uuid);
          }
        }
        onClose();
        break;

      case 'property':
        if (item.result?.property) {
          openPropertyView(item.result.property.uuid);
        }
        onClose();
        break;

      case 'add-page':
        try {
          if (!pageClassUuid) {
            notifyWarning('Setup incomplete', 'Page class not found. Please reload the app.');
            break;
          }

          const parsed = parseHierarchicalPath(pageNameForCreation);
          let parentUuid: string | null = null;
          const classUuids = [pageClassUuid, ...selectedClasses.map(c => c.uuid)];

          if (parsed.isHierarchical) {
            const freshPages = await listNodes({ pages_only: true, include_children: true });
            parentUuid = await resolveHierarchicalParentUuid(
              parsed.parentSegments,
              freshPages,
              async (name, parent) => {
                return await createNodeMutation.mutateAsync({
                  name,
                  parent_uuid: parent,
                  class_uuids: [pageClassUuid],
                });
              }
            );
          }

          try {
            const newNode = await createNodeMutation.mutateAsync({
              name: parsed.leaf || pageNameForCreation,
              parent_uuid: parentUuid,
              class_uuids: classUuids,
            });
            onClose();
            openNode(newNode.uuid);
          } catch (createErr: unknown) {
            const axiosErr = createErr as { response?: { status?: number; data?: { detail?: { message?: string; conflicting_classes?: string[] } | string } } };
            if (axiosErr.response?.status === 409) {
              const detail = axiosErr.response.data?.detail;
              const conflicting = typeof detail === 'object' && detail !== null ? (detail.conflicting_classes || []) : [];
              setDuplicateModal({
                isOpen: true,
                pageName: parsed.leaf || pageNameForCreation,
                conflictingClasses: conflicting,
                originalClasses: classUuids,
                parentUuid: parentUuid,
              });
            } else {
              notifyError('Failed to create page', 'Please try again.');
            }
          }
        } catch {
          notifyError('Failed to create page', 'Please try again.');
        }
        break;

      case 'quick-add':
        if (!destinationPage) {
          notifyWarning('No destination', 'Set a Quick Add destination in settings.');
          break;
        }
        try {
          await createNodeMutation.mutateAsync({
            name: searchTerm.trim(),
            parent_uuid: destinationPage.uuid,
            class_uuids: selectedClasses.map(c => c.uuid),
          });
        } catch {
          notifyError('Failed to add item', 'Please try again.');
        }
        onClose();
        break;

      case 'command': {
        if (item.commandId) {
          useCommandRegistry.getState().executeCommand(item.commandId);
        }
        onClose();
        break;
      }

      case 'show-more':
        if (item.showMoreSection === 'pages') setMaxPages(prev => prev + 10);
        else if (item.showMoreSection === 'blocks') setMaxBlocks(prev => prev + 10);
        else if (item.showMoreSection === 'properties') setMaxProperties(prev => prev + 10);
        return;

      case 'filter-prefix':
        if (item.filterPrefix) handlePrefixSelect(item.filterPrefix.prefix);
        return;

      case 'boolean-option':
        if (item.booleanValue !== undefined) handleBooleanSelect(item.booleanValue);
        return;
    }
  }, [
    allItems, searchTerm, pageNameForCreation, selectedClasses, pageClassUuid,
    destinationPage, onSelect, openNode, openPropertyView, createNodeMutation,
    onClose, queryClient, handlePrefixSelect, handleBooleanSelect,
    setDuplicateModal, setMaxPages, setMaxBlocks, setMaxProperties,
    notifyError, notifyWarning, workspaceUuid,
  ]);

  return { handleSelect };
}
