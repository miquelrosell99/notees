/**
 * NodeLinkContextMenu — unified right-click menu for inline node links.
 *
 * Used by both the custom inline editor and read-only inline renderers.
 * Supports node/class links, URL links, and broken links. For broken links,
 * exposes a "Copy UUID" action (and a create-page action when a fix callback
 * is available).
 */
import { useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { useNavigationStore } from '@/stores';
import { useClasses } from '@/features/content/hooks/useNodeListQueries';
import { useReferencedNode } from '@/features/content/contexts/useReferencedNode';
import { useBrokenLinkFix } from '@/features/content/contexts/BrokenLinkFixContext';
import { useBatchedNodeByUuid } from '@/hooks';
import { copyToClipboard } from '@/utils/clipboardManager';
import { parseLinkId } from '@/lib/astBuilder';

export type NodeLinkContextMenuRefType =
  | 'node'
  | 'class'
  | 'url'
  | 'broken'
  | 'embed'
  | 'user';

export interface NodeLinkContextMenuProps {
  /** Compound link ID (nodeUuid:linkUuid for node/class/broken links). */
  linkId: string;
  /** What kind of link this is. */
  refType: NodeLinkContextMenuRefType;
  /** Custom display label, if any. */
  label?: string | null;
  /** URL for external-link pills. */
  url?: string;
  /** Optional pre-resolved target node UUID (otherwise parsed from linkId). */
  nodeUuid?: string;
  /** Screen position where the menu should appear. */
  position: { x: number; y: number };
  /** Called when the menu should close. */
  onClose: () => void;
  /** If provided, enables the "Edit link" action. */
  onEdit?: () => void;
  /** If provided, enables the "Remove" action. */
  onRemove?: () => void;
  /** If provided, enables the "Toggle inline class" action. */
  onToggleClass?: () => void;
}

export function NodeLinkContextMenu({
  linkId,
  refType,
  label: _label,
  url,
  nodeUuid: explicitNodeUuid,
  position,
  onClose,
  onEdit,
  onRemove,
  onToggleClass,
}: NodeLinkContextMenuProps) {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const openNode = useNavigationStore((s) => s.openNode);
  const addSidebarCard = useNavigationStore((s) => s.addSidebarCard);
  const fixBrokenLink = useBrokenLinkFix();

  const { nodeUuid: parsedNodeUuid } = parseLinkId(linkId);
  const targetUuid = explicitNodeUuid ?? parsedNodeUuid;

  const refNode = useReferencedNode(targetUuid ?? null);
  const { data: fetchedNode } = useBatchedNodeByUuid(
    !refNode && targetUuid ? targetUuid : null,
    { skipGlobalError: true },
  );
  const targetNode = refNode ?? fetchedNode ?? null;

  const { data: allClasses } = useClasses();
  const isTargetClass =
    targetNode && allClasses?.some((cls) => cls.uuid === targetNode.uuid);

  const openInNewTab = useCallback(
    (href: string) => {
      window.open(href, '_blank', 'noopener,noreferrer');
    },
    [],
  );

  const menuItems = useMemo((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    if (refType === 'url') {
      if (url) {
        items.push({
          id: 'open',
          label: 'Open in new tab',
          icon: 'mdi-open-in-new',
          onClick: () => {
            openInNewTab(url);
            onClose();
          },
        });
        items.push({
          id: 'copy-url',
          label: 'Copy URL',
          icon: 'mdi-content-copy',
          onClick: () => {
            void copyToClipboard(url);
            onClose();
          },
        });
      }
    } else if (refType === 'broken') {
      if (targetUuid) {
        items.push({
          id: 'copy-uuid',
          label: 'Copy UUID',
          icon: 'mdi-identifier',
          onClick: () => {
            void copyToClipboard(targetUuid);
            onClose();
          },
        });
        if (fixBrokenLink) {
          items.push({
            id: 'create-page',
            label: 'Create page with UUID',
            icon: 'mdi-plus-circle-outline',
            onClick: () => {
              fixBrokenLink(targetUuid);
              onClose();
            },
          });
        }
      }
    } else {
      // node / class / embed / user
      const isPage = targetNode ? targetNode.is_page : refType !== 'class';
      const openLabel =
        refType === 'class'
          ? 'Open class'
          : isPage
            ? 'Open page'
            : 'Open block';

      items.push({
        id: 'open',
        label: openLabel,
        icon: 'mdi-open-in-app',
        onClick: () => {
          if (targetUuid) openNode(targetUuid);
          onClose();
        },
      });
      items.push({
        id: 'open-sidebar',
        label: 'Open in sidebar',
        icon: 'mdi-dock-right',
        shortcut: '⇧Click',
        onClick: () => {
          if (targetUuid) addSidebarCard(targetUuid, isPage ? 'page' : 'block');
          onClose();
        },
      });
      items.push({
        id: 'open-new-tab',
        label: 'Open in new browser tab',
        icon: 'mdi-open-in-new',
        shortcut: 'Ctrl/Cmd+Click',
        onClick: () => {
          if (targetUuid) openInNewTab(`/${workspaceId ?? ''}/${targetUuid}`);
          onClose();
        },
      });
    }

    const hasEditActions = onEdit || onRemove || onToggleClass;
    const isEditableLink = refType !== 'url' && refType !== 'broken';

    if (hasEditActions || isTargetClass) {
      items.push({ id: 'sep-edit', label: '', separator: true });
    }

    if (onEdit) {
      items.push({
        id: 'edit',
        label: 'Edit link',
        icon: 'mdi-pencil',
        onClick: () => {
          onEdit();
          onClose();
        },
      });
    }

    if (isTargetClass && isEditableLink && onToggleClass) {
      items.push({
        id: 'toggle-class',
        label:
          refType === 'class'
            ? 'Convert to normal link'
            : 'Convert to inline class',
        icon: refType === 'class' ? 'mdi-link-variant' : 'mdi-tag',
        onClick: () => {
          onToggleClass();
          onClose();
        },
      });
    }

    if (refType !== 'url' && targetUuid) {
      if (items.length > 0 && !items[items.length - 1].separator) {
        items.push({ id: 'sep-copy', label: '', separator: true });
      }
      items.push({
        id: 'copy-uuid',
        label: 'Copy UUID',
        icon: 'mdi-identifier',
        onClick: () => {
          void copyToClipboard(targetUuid);
          onClose();
        },
      });
      if (refType === 'node' || refType === 'class') {
        items.push({
          id: 'copy-link',
          label: 'Copy link',
          icon: 'mdi-link-variant',
          onClick: () => {
            void copyToClipboard(`[[${targetUuid}]]`);
            onClose();
          },
        });
      }
    }

    if (onRemove) {
      if (items.length > 0 && !items[items.length - 1].separator) {
        items.push({ id: 'sep-remove', label: '', separator: true });
      }
      items.push({
        id: 'remove',
        label: 'Remove',
        icon: 'mdi-trash-can-outline',
        danger: true,
        onClick: () => {
          onRemove();
          onClose();
        },
      });
    }

    return items;
  }, [
    refType,
    url,
    targetUuid,
    targetNode,
    isTargetClass,
    fixBrokenLink,
    onEdit,
    onRemove,
    onToggleClass,
    openNode,
    addSidebarCard,
    openInNewTab,
    workspaceId,
    onClose,
  ]);

  return (
    <ContextMenu
      items={menuItems}
      position={position}
      onClose={onClose}
    />
  );
}
