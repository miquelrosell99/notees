import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Node } from '@/types';
import {
  getOrCreateDailyNoteClient,
  getOrCreateMonthlyNoteClient,
  getOrCreateYearlyNoteClient,
  useCreateNode,
} from '@/features/content';
import { useNavigationStore } from '@/stores';
import { useCommandRegistry } from '@/stores/commandRegistry';
import { useNotifications } from '@/stores/notificationStore';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import type { ItemEntry, DuplicateModalState } from './CommandPalette.types';

interface UseCommandPaletteSelectionParams {
  allItems: ItemEntry[];
  searchTerm: string;
  pageNameForCreation: string;
  selectedClasses: Node[];
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
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');
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
        if (!pd || !workspaceUuid || !client) break;
        try {
          let dateNode: Node;
          if (item.existingNode) {
            dateNode = item.existingNode;
          } else {
            if (pd.type === 'day' && pd.month && pd.day) {
              const dateStr = `${pd.year}-${String(pd.month).padStart(2, '0')}-${String(pd.day).padStart(2, '0')}`;
              dateNode = await getOrCreateDailyNoteClient(client, dateStr);
            } else if (pd.type === 'month' && pd.month) {
              dateNode = await getOrCreateMonthlyNoteClient(client, pd.year, pd.month);
            } else {
              dateNode = await getOrCreateYearlyNoteClient(client, pd.year);
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
          const classUuids = selectedClasses.map(c => c.uuid);

          try {
            const newNode = await createNodeMutation.mutateAsync({
              name: pageNameForCreation,
              kind: 'page',
              parent_uuid: null,
              class_uuids: classUuids.length > 0 ? classUuids : undefined,
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
                pageName: pageNameForCreation,
                conflictingClasses: conflicting,
                originalClasses: classUuids,
                parentUuid: null,
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
    allItems, searchTerm, pageNameForCreation, selectedClasses,
    destinationPage, onSelect, openNode, openPropertyView, createNodeMutation,
    onClose, queryClient, handlePrefixSelect, handleBooleanSelect,
    setDuplicateModal, setMaxPages, setMaxBlocks, setMaxProperties,
    notifyError, notifyWarning, workspaceUuid, client,
  ]);

  return { handleSelect };
}
