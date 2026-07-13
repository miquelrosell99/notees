/**
 * Archived Node Context Menu
 * 
 * Context menu for archived nodes with unarchive and delete actions.
 */
import { useCallback, useState } from 'react';
import { useUnarchiveNode, useDeleteNode, useLinkedReferencesCount } from '@/features/content';
import { nodeNameToText } from '@/features/queries';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { useAddSidebarCardAction, useOpenLocalGraphAction } from '@/features/layout';
import { useSettingsStore } from '@/stores';
import {
  getVisibleNodeActions,
  NODE_ACTION_DEFAULT_ORDER,
  useNodeActions,
  type NodeActionContext,
  type NodeMenuGroup,
} from '@/plugins/core';
import type { Node } from '@/types';
import { copyToClipboard } from '@/utils/clipboardManager';
import { composeMenuItems, type ComposableMenuItem } from './NodeContextMenu/composeMenuItems';
import './NodeContextMenu.css';

/**
 * Menu section for each core item (ids as built below). 'unarchive' lands in
 * 'main'. Differs slightly from the historical flat layout: copy actions now
 * form their own section.
 */
const ARCHIVED_ITEM_GROUP: Record<string, NodeMenuGroup> = {
  'copy-uuid': 'copy',
  'copy-link': 'copy',
  'open-sidebar': 'manage',
  'local-graph': 'manage',
  delete: 'danger',
};

interface ArchivedNodeContextMenuProps {
  /** The node to show context menu for */
  node: Node;
  /** Position for the menu */
  position: { x: number; y: number };
  /** Callback to close the menu */
  onClose: () => void;
}

/**
 * Context menu for archived nodes
 */
export function ArchivedNodeContextMenu({ node, position, onClose }: ArchivedNodeContextMenuProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showUnarchiveModal, setShowUnarchiveModal] = useState(false);
  const unarchiveNode = useUnarchiveNode();
  const deleteNode = useDeleteNode();
  const addSidebarCard = useAddSidebarCardAction();
  const openLocalGraph = useOpenLocalGraphAction();
  const showDevOptions = useSettingsStore((s) => s.showDevOptions);
  const pluginActions = useNodeActions();
  const { count: linkedRefsCount } = useLinkedReferencesCount(node.uuid);
  
  const handleUnarchiveClick = useCallback(() => {
    setShowUnarchiveModal(true);
  }, []);
  
  const handleConfirmUnarchive = useCallback(() => {
    unarchiveNode.mutate(node.uuid);
    setShowUnarchiveModal(false);
    onClose();
  }, [node.uuid, unarchiveNode, onClose]);
  
  const handleCancelUnarchive = useCallback(() => {
    setShowUnarchiveModal(false);
    onClose();
  }, [onClose]);
  
  const handleDeleteClick = useCallback(() => {
    setShowDeleteModal(true);
  }, []);
  
  const handleConfirmDelete = useCallback(() => {
    deleteNode.mutate(node.uuid);
    setShowDeleteModal(false);
    onClose();
  }, [node.uuid, deleteNode, onClose]);
  
  const handleCancelDelete = useCallback(() => {
    setShowDeleteModal(false);
    onClose();
  }, [onClose]);
  
  const baseItems: ContextMenuItem[] = [
    {
      id: 'unarchive',
      label: 'Unarchive',
      icon: 'mdi-archive-arrow-up-outline',
      keepOpen: true,
      onClick: handleUnarchiveClick,
    },
    {
      id: 'copy-uuid',
      label: 'Copy UUID',
      icon: 'mdi-identifier',
      onClick: () => {
        copyToClipboard(node.uuid);
        onClose();
      }
    },
    {
      id: 'copy-link',
      label: 'Copy link',
      icon: 'mdi-link-variant',
      onClick: () => {
        const link = `[[${node.uuid}]]`;
        copyToClipboard(link);
        onClose();
      }
    },
    {
      id: 'open-sidebar',
      label: 'Open in sidebar',
      icon: 'mdi-dock-right',
      onClick: () => {
        addSidebarCard(node.uuid, node.is_page ? 'page' : 'block');
        onClose();
      }
    },
    {
      id: 'local-graph',
      label: 'Show local graph',
      icon: 'mdi-graph-outline',
      onClick: () => {
        openLocalGraph(node.uuid);
        onClose();
      }
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: 'mdi-delete-outline',
      danger: true,
      keepOpen: true,
      onClick: handleDeleteClick,
    },
  ];

  // Merge contributed node actions targeting the archived menu (see
  // NodeActionRegistry) and compose sections; destructive section last.
  const actionContext: NodeActionContext = {
    menu: 'archived',
    nodeUuid: node.uuid,
    node,
    close: onClose,
  };
  const contributed = getVisibleNodeActions(pluginActions, {
    nodeScope: node.is_page ? 'page' : 'block',
    showDevOptions,
    context: actionContext,
  });
  const composed: ComposableMenuItem[] = baseItems.map((item, index) => ({
    ...item,
    group: ARCHIVED_ITEM_GROUP[item.id] ?? 'main',
    order: index,
  }));
  contributed.forEach((action, regIndex) => {
    composed.push({
      id: `plugin:${action.id}`,
      label: action.label,
      icon: action.icon,
      shortcut: action.shortcut,
      badge: action.badge ?? (action.devOnly ? 'DEV' : undefined),
      danger: action.danger,
      keepOpen: action.keepOpen,
      group: action.group,
      order: action.order ?? NODE_ACTION_DEFAULT_ORDER + regIndex,
      onClick: () => {
        action.execute(actionContext);
        if (!action.keepOpen) onClose();
      },
    });
  });
  const menuItems = composeMenuItems(composed);
  
  return (
    <>
      {!showDeleteModal && !showUnarchiveModal && (
        <ContextMenu
          items={menuItems}
          position={position}
          onClose={onClose}
        />
      )}
      <ConfirmationModal
        isOpen={showUnarchiveModal}
        title="Unarchive Page"
        message={`Unarchive "${nodeNameToText(node.name) || 'Untitled'}"? It will be restored to normal view.`}
        confirmLabel="Unarchive"
        cancelLabel="Cancel"
        variant="primary"
        onConfirm={handleConfirmUnarchive}
        onCancel={handleCancelUnarchive}
      />
      <ConfirmationModal
        isOpen={showDeleteModal}
        title={`Delete ${node.is_page ? 'page' : 'block'}`}
        message={`Are you sure you want to delete "${nodeNameToText(node.name) || 'Untitled'}"? It will be moved to trash.`}
        secondaryMessage={linkedRefsCount > 0 ? `This ${node.is_page ? 'page' : 'block'} is linked in ${linkedRefsCount} other node${linkedRefsCount === 1 ? '' : 's'}.` : undefined}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </>
  );
}

