/**
 * NodeLinkContextMenu — unified right-click menu for inline node links.
 *
 * Used by both the custom inline editor and read-only inline renderers.
 * Supports node/class links, URL links, and broken links. For broken links,
 * exposes a "Copy UUID" action (and a create-page action when a fix callback
 * is available). "Copy UUID" is a dev action: hidden unless
 * `showDevOptions` is enabled in the settings store.
 *
 * Editable pills (editor) also get "Delete" (remove the pill entirely) and
 * "Unlink" (replace the link with plain text, keeping its visible label).
 * Class/tag pills (via NodeRef) get a color picker row on top.
 */
import { useMemo, useCallback } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { useNavigationStore, useSettingsStore } from '@/stores';
import { useClasses } from '@/features/content/hooks/useNodeListQueries';
import { useNodeDisplay } from '@/features/content/hooks/useNodeDisplay';
import { useReferencedNode } from '@/features/content/contexts/useReferencedNode';
import { useBrokenLinkFix } from '@/features/content/contexts/BrokenLinkFixContext';
import { useBatchedNodeByUuid } from '@/hooks';
import { copyToClipboard } from '@/utils/clipboardManager';
import { parseLinkId } from '@/lib/astBuilder';
import { ColorPickerRow } from './ColorPickerRow';

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
  /** If provided, enables the "Delete" action (removes the pill entirely). */
  onRemove?: () => void;
  /** If provided, enables the "Unlink" action (keeps the visible text). Receives the text to keep. */
  onUnlink?: (keepText: string) => void;
  /** If provided, enables the "Toggle inline class" action. */
  onToggleClass?: () => void;
  /** Current pill color (for the color picker row). */
  currentColor?: string | null;
  /** If provided, shows the color picker row at the top of the menu. */
  onColorChange?: (color: string | null) => void;
}

export function NodeLinkContextMenu({
  linkId,
  refType,
  label,
  url,
  nodeUuid: explicitNodeUuid,
  position,
  onClose,
  onEdit,
  onRemove,
  onUnlink,
  onToggleClass,
  currentColor,
  onColorChange,
}: NodeLinkContextMenuProps) {
  const openNode = useNavigationStore((s) => s.openNode);
  const addSidebarCard = useNavigationStore((s) => s.addSidebarCard);
  const showDevOptions = useSettingsStore((s) => s.showDevOptions);
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

  // Resolved display name of the target — used as the kept text when unlinking
  // a link that has no custom label.
  const { displayText } = useNodeDisplay(targetNode, 'Untitled');

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
        if (showDevOptions) {
          items.push({
            id: 'copy-uuid',
            label: 'Copy UUID',
            icon: 'mdi-identifier',
            badge: 'DEV',
            onClick: () => {
              void copyToClipboard(targetUuid);
              onClose();
            },
          });
        }
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
        refType === 'class' || isTargetClass
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

    // Copy actions. Copy UUID is a dev action — hidden unless dev options
    // are enabled in the user settings.
    if (refType !== 'url' && targetUuid) {
      const copyItems: ContextMenuItem[] = [];
      if (showDevOptions) {
        copyItems.push({
          id: 'copy-uuid',
          label: 'Copy UUID',
          icon: 'mdi-identifier',
          badge: 'DEV',
          onClick: () => {
            void copyToClipboard(targetUuid);
            onClose();
          },
        });
      }
      if (refType === 'node' || refType === 'class') {
        copyItems.push({
          id: 'copy-link',
          label: 'Copy link',
          icon: 'mdi-link-variant',
          onClick: () => {
            void copyToClipboard(`[[${targetUuid}]]`);
            onClose();
          },
        });
      }
      if (copyItems.length > 0) {
        if (items.length > 0 && !items[items.length - 1].separator) {
          items.push({ id: 'sep-copy', label: '', separator: true });
        }
        items.push(...copyItems);
      }
    }

    // Delete actions: Delete removes the pill entirely; Unlink replaces it
    // with plain text, keeping the visible label.
    const deleteItems: ContextMenuItem[] = [];
    if (onRemove) {
      deleteItems.push({
        id: 'delete',
        label: 'Delete',
        icon: 'mdi-trash-can-outline',
        danger: true,
        onClick: () => {
          onRemove();
          onClose();
        },
      });
    }
    if (onUnlink) {
      const keepText =
        refType === 'url'
          ? label || url || ''
          : refType === 'broken'
            ? label || linkId.split(':')[0]
            : label || displayText;
      deleteItems.push({
        id: 'unlink',
        label: 'Unlink',
        icon: 'mdi-link-variant-off',
        onClick: () => {
          onUnlink(keepText);
          onClose();
        },
      });
    }
    if (deleteItems.length > 0) {
      if (items.length > 0 && !items[items.length - 1].separator) {
        items.push({ id: 'sep-delete', label: '', separator: true });
      }
      items.push(...deleteItems);
    }

    // Color picker row on top (class/tag pills via NodeRef).
    if (onColorChange) {
      items.unshift({
        id: 'color-row',
        label: '',
        content: (
          <ColorPickerRow
            currentColor={currentColor ?? null}
            onColorChange={onColorChange}
          />
        ),
      });
    }

    return items;
  }, [
    linkId,
    refType,
    label,
    url,
    targetUuid,
    targetNode,
    isTargetClass,
    displayText,
    showDevOptions,
    fixBrokenLink,
    onEdit,
    onRemove,
    onUnlink,
    onToggleClass,
    currentColor,
    onColorChange,
    openNode,
    addSidebarCard,
    openInNewTab,
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
