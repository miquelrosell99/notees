/**
 * InlineLink — React component rendered inside InlineLinkNode (DecoratorNode).
 *
 * Lexical portals this into the InlineLinkNode's DOM element (<span class="inline-link-wrapper">).
 * Delegates node resolution and rendering to NodeRef (variant="inline").
 *
 * Supports URL pills (refType === 'url') that render an external-link pill.
 *
 * NEW: Right-click context menu with options:
 *   - Open / Open in sidebar / Open in new tab
 *   - Edit link (opens LinkEditModal)
 *   - Toggle inline class (for links pointing to class nodes)
 *   - Remove link
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $isElementNode, type ElementNode } from 'lexical';
import { NodeRef } from '@/features/content';
import { parseLinkId, buildLinkId } from '@/lib/astBuilder';
import { generateUUID } from '@/utils/uuid';
import type { InlineLinkRefType } from '@/features/editor/editor/nodes/InlineLinkNode';
import type { SidebarCardType } from '@/stores';
import type { InlineLinkNode } from '@/features/editor/editor/nodes/InlineLinkNode';
import {
  $isInlineLinkNode,
  $createInlineLinkNode,
} from '@/features/editor/editor/nodes/InlineLinkNode';
import { Icon } from '@/components/ui/icons';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { LinkEditModal, type LinkEditResult } from './LinkEditModal';
import { TransclusionPopover } from '@/features/content';
import { useNavigationStore } from '@/stores';
import { useClasses } from '@/features/content';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';

export interface InlineLinkProps {
  linkId: string;
  refType: InlineLinkRefType;
  /** URL for external-link pills. */
  url?: string;
  /** Custom display label — overrides target node name when set. */
  label?: string;
}

export function InlineLink({ linkId, refType, url, label }: InlineLinkProps) {
  const [editor] = useLexicalComposerContext();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isEmbedOpen, setIsEmbedOpen] = useState(false);
  const embedAnchorRef = useRef<HTMLButtonElement>(null);
  const embedHoverTimer = useRef<number | null>(null);

  const { nodeUuid } = parseLinkId(linkId);
  const openNode = useNavigationStore((s) => s.openNode);
  const addSidebarCard = useNavigationStore((s) => s.addSidebarCard);
  const { data: allClasses } = useClasses();

  /** Whether the linked node is a class (enables "toggle inline class" option). */
  const isTargetClass = useMemo(() => {
    if (!nodeUuid || !allClasses) return false;
    return allClasses.some((c) => c.uuid === nodeUuid);
  }, [allClasses, nodeUuid]);

  /** Find the InlineLinkNode in the Lexical tree by linkId and apply a mutation. */
  const findAndMutateLink = useCallback(
    (mutator: (node: InlineLinkNode) => void) => {
      editor.update(() => {
        const root = $getRoot();
        const findNode = (
          parent: ElementNode,
        ): InlineLinkNode | null => {
          for (const child of parent.getChildren()) {
            if ($isInlineLinkNode(child) && child.getLinkId() === linkId) {
              return child;
            }
            if ($isElementNode(child)) {
              const found = findNode(child);
              if (found) return found;
            }
          }
          return null;
        };
        const node = findNode(root);
        if (node) mutator(node);
      });
    },
    [editor, linkId],
  );

  const handleOpen = useCallback(async () => {
    if (refType === 'url' && url) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!nodeUuid) return;

    const runtime = getOperationRuntime();
    const graphNode = getNode(runtime, nodeUuid);

    if (graphNode?.blockId) {
      openNode(graphNode.blockId);
      return;
    }

    // Fallback: fetch by UUID
    try {
      const { getNodeByUuid } = await import('@/api/nodes');
      const node = await getNodeByUuid(nodeUuid);
      if (node) {
        openNode(node.uuid);
      }
    } catch {
      // Node not found or network error — silently ignore
    }
  }, [refType, url, nodeUuid, openNode]);

  const handleOpenSidebar = useCallback(async () => {
    if (!nodeUuid) return;

    const runtime = getOperationRuntime();
    const graphNode = getNode(runtime, nodeUuid);

    if (graphNode?.blockId) {
      const cardType: SidebarCardType = graphNode.isPage ? 'page' : 'block';
      addSidebarCard(graphNode.blockId, cardType);
      return;
    }

    // Fallback: fetch by UUID
    try {
      const { getNodeByUuid } = await import('@/api/nodes');
      const node = await getNodeByUuid(nodeUuid);
      if (node) {
        const cardType: SidebarCardType = node.is_page ? 'page' : 'block';
        addSidebarCard(node.uuid, cardType);
      }
    } catch {
      // Silently ignore
    }
  }, [nodeUuid, addSidebarCard]);

  const handleRemove = useCallback(() => {
    findAndMutateLink((node) => {
      node.remove();
    });
  }, [findAndMutateLink]);

  const handleToggleInlineClass = useCallback(() => {
    const newRefType: InlineLinkRefType = refType === 'class' ? 'node' : 'class';
    findAndMutateLink((node) => {
      const newNode = $createInlineLinkNode(
        node.getLinkId(),
        newRefType,
        node.getUrl() || undefined,
        node.getLabel() || undefined,
      );
      node.replace(newNode);
    });
  }, [findAndMutateLink, refType]);

  const handleEditSave = useCallback(
    (result: LinkEditResult) => {
      findAndMutateLink((node) => {
        if (result.mode === 'url') {
          const newNode = $createInlineLinkNode(
            result.label || result.url || '',
            'url',
            result.url,
            result.label || undefined,
          );
          node.replace(newNode);
        } else if (result.targetNode) {
          const newLinkId = buildLinkId(result.targetNode.uuid, generateUUID());
          const newNode = $createInlineLinkNode(
            newLinkId,
            'node',
            undefined,
            result.label || undefined,
          );
          node.replace(newNode);
        } else {
          // Only label changed — keep same target, update label
          const newNode = $createInlineLinkNode(
            node.getLinkId(),
            node.getRefType(),
            node.getUrl() || undefined,
            result.label || undefined,
          );
          node.replace(newNode);
        }
      });
      setIsEditModalOpen(false);
    },
    [findAndMutateLink],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setMenuPos({ x: e.clientX, y: e.clientY });
    },
    [],
  );

  const handleEmbedOpen = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsEmbedOpen(true);
  }, []);

  const handleEmbedClose = useCallback(() => {
    setIsEmbedOpen(false);
    if (embedHoverTimer.current) {
      window.clearTimeout(embedHoverTimer.current);
      embedHoverTimer.current = null;
    }
  }, []);

  const handleEmbedMouseEnter = useCallback(() => {
    if (embedHoverTimer.current) {
      window.clearTimeout(embedHoverTimer.current);
    }
    embedHoverTimer.current = window.setTimeout(() => {
      setIsEmbedOpen(true);
    }, 400);
  }, []);

  const handleEmbedMouseLeave = useCallback(() => {
    if (embedHoverTimer.current) {
      window.clearTimeout(embedHoverTimer.current);
      embedHoverTimer.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (embedHoverTimer.current) {
        window.clearTimeout(embedHoverTimer.current);
      }
    };
  }, []);

  const menuItems = useMemo((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    if (refType === 'url') {
      items.push({
        id: 'open',
        label: 'Open in new tab',
        icon: 'mdi mdi-open-in-new',
        onClick: handleOpen,
      });
    } else if (refType === 'broken') {
      items.push({
        id: 'open',
        label: 'Open',
        icon: 'mdi mdi-open-in-app',
        onClick: handleOpen,
      });
    } else {
      const isPage = refType === 'node' || refType === 'user';
      items.push({
        id: 'open',
        label: isPage ? 'Open page' : 'Open block',
        icon: 'mdi mdi-open-in-app',
        onClick: handleOpen,
      });
      items.push({
        id: 'open-sidebar',
        label: 'Open in sidebar',
        icon: 'mdi mdi-dock-right',
        shortcut: '⇧Click',
        onClick: handleOpenSidebar,
      });
    }

    items.push({ id: 'sep1', label: '', separator: true });

    items.push({
      id: 'edit',
      label: 'Edit link',
      icon: 'mdi mdi-pencil',
      onClick: () => setIsEditModalOpen(true),
    });

    if (isTargetClass && refType !== 'url' && refType !== 'broken') {
      items.push({
        id: 'toggle-class',
        label:
          refType === 'class'
            ? 'Convert to normal link'
            : 'Convert to inline class',
        icon: refType === 'class' ? 'mdi mdi-link-variant' : 'mdi mdi-tag',
        onClick: handleToggleInlineClass,
      });
    }

    items.push({ id: 'sep2', label: '', separator: true });

    items.push({
      id: 'remove',
      label: 'Remove',
      icon: 'mdi mdi-trash-can-outline',
      danger: true,
      onClick: handleRemove,
    });

    return items;
  }, [
    refType,
    isTargetClass,
    handleOpen,
    handleOpenSidebar,
    handleToggleInlineClass,
    handleRemove,
  ]);

  const handleCloseMenu = useCallback(() => {
    setMenuPos(null);
  }, []);

  const handleCloseEditModal = useCallback(() => {
    setIsEditModalOpen(false);
  }, []);

  // ─── URL pill ──────────────────────────────────────────────
  if (refType === 'url') {
    const customLabel = linkId && linkId !== url ? linkId : null;
    const displayText =
      customLabel ??
      (url
        ? url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 50) || url
        : 'URL');

    return (
      <>
        <span
          className="inline-link-inner"
          data-ref-type="url"
          title={customLabel ? url : undefined}
          onContextMenu={handleContextMenu}
        >
          <span className="inline-link-icon">
            <Icon path={"mdi mdi-web"} size="14px" />
          </span>
          <span className="inline-link-text">{displayText}</span>
        </span>
        {menuPos && (
          <ContextMenu
            items={menuItems}
            position={menuPos}
            onClose={handleCloseMenu}
          />
        )}
        {isEditModalOpen && (
          <LinkEditModal
            isOpen={true}
            linkId={linkId}
            refType="url"
            currentUrl={url}
            currentLabel={customLabel}
            onSave={handleEditSave}
            onClose={handleCloseEditModal}
          />
        )}
      </>
    );
  }

  // ─── Broken link pill ──────────────────────────────────────
  if (refType === 'broken') {
    const text = label || linkId.split(':')[0] || '⛓️‍💥';
    return (
      <>
        <span
          className="inline-link-inner broken-link"
          data-ref-type="broken"
          title={`Broken link: ${linkId}`}
          onContextMenu={handleContextMenu}
        >
          <span className="inline-link-text">{text}</span>
        </span>
        {menuPos && (
          <ContextMenu
            items={menuItems}
            position={menuPos}
            onClose={handleCloseMenu}
          />
        )}
        {isEditModalOpen && (
          <LinkEditModal
            isOpen={true}
            linkId={linkId}
            refType="broken"
            currentLabel={label}
            onSave={handleEditSave}
            onClose={handleCloseEditModal}
          />
        )}
      </>
    );
  }

  // ─── User mention pill ─────────────────────────────────────
  if (refType === 'user') {
    return (
      <>
        <span
          className="inline-link-inner inline-link-inner--user"
          data-ref-type="user"
          onContextMenu={handleContextMenu}
        >
          <span className="inline-link-icon">
            <Icon path={"mdi mdi-at"} size="14px" />
          </span>
          <span className="inline-link-text">{label || nodeUuid?.slice(0, 8)}</span>
        </span>
        {menuPos && (
          <ContextMenu
            items={menuItems}
            position={menuPos}
            onClose={handleCloseMenu}
          />
        )}
        {isEditModalOpen && (
          <LinkEditModal
            isOpen={true}
            linkId={linkId}
            refType="user"
            currentLabel={label}
            onSave={handleEditSave}
            onClose={handleCloseEditModal}
          />
        )}
      </>
    );
  }

  // ─── Embed pill ────────────────────────────────────────────
  if (refType === 'embed' && nodeUuid) {
    return (
      <>
        <button
          type="button"
          ref={embedAnchorRef}
          className="inline-link-inner inline-link-inner--embed"
          data-ref-type="embed"
          onClick={handleEmbedOpen}
          onMouseEnter={handleEmbedMouseEnter}
          onMouseLeave={handleEmbedMouseLeave}
          onContextMenu={handleContextMenu}
          aria-haspopup="dialog"
          aria-expanded={isEmbedOpen}
        >
          <span className="inline-link-icon">
            <Icon path="mdi-cube-outline" size="14px" />
          </span>
          <NodeRef variant="inline" nodeUuid={nodeUuid} refType="node" customName={label} />
        </button>
        {isEmbedOpen && embedAnchorRef.current && (
          <TransclusionPopover
            nodeUuid={nodeUuid}
            anchorEl={embedAnchorRef.current}
            onClose={handleEmbedClose}
          />
        )}
        {menuPos && (
          <ContextMenu items={menuItems} position={menuPos} onClose={handleCloseMenu} />
        )}
        {isEditModalOpen && (
          <LinkEditModal
            isOpen={true}
            linkId={linkId}
            refType={refType}
            currentLabel={label}
            onSave={handleEditSave}
            onClose={handleCloseEditModal}
          />
        )}
      </>
    );
  }

  // ─── Node / class pill ─────────────────────────────────────
  return (
    <>
      <span onContextMenu={handleContextMenu}>
        <NodeRef
          variant="inline"
          nodeUuid={nodeUuid}
          refType={refType as 'node' | 'class'}
          customName={label}
        />
      </span>
      {menuPos && (
        <ContextMenu
          items={menuItems}
          position={menuPos}
          onClose={handleCloseMenu}
        />
      )}
      {isEditModalOpen && (
        <LinkEditModal
          isOpen={true}
          linkId={linkId}
          refType={refType}
          currentLabel={label}
          onSave={handleEditSave}
          onClose={handleCloseEditModal}
        />
      )}
    </>
  );
}