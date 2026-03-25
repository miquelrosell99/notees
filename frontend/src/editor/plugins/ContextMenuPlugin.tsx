/**
 * ContextMenuPlugin — Handles bullet interactions and context menus.
 *
 * Features:
 * - Click on collapse arrow: toggle collapsed state
 * - Right-click on bullet: show context menu
 * - Shift+click on bullet: open in sidebar
 * - Click on bullet: navigate to focused view
 */

import { useState, useEffect, useCallback, useMemo, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $createTextNode, $createLineBreakNode, type LexicalNode } from 'lexical';
import { mdiPencilOutline, mdiTrashCanOutline, mdiLinkVariantOff } from '@mdi/js';

import { $isBlockNode } from '../nodes/BlockNode';
import { $isInlineLinkNode, $createInlineLinkNode } from '../nodes/InlineLinkNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { serializeContentAST } from '../editorConfig';
import type { InlineLinkRefType } from '../nodes/InlineLinkNode';
import { parseLinkId, buildLinkId, parseAST } from '../../lib/astBuilder';
import { generateUUID } from '../../utils/uuid';
import type { ASTInlineNode, ASTDocument } from '../../types/ast';
import { getNodeByUuid } from '../../api/nodes';
import { PageContextMenu, BlockContextMenu } from '../../components/nodes/NodeContextMenu';
import { ContextMenu, type ContextMenuItem } from '../../components/core/ContextMenu';
import type { Node } from '../../types/api';

export interface ContextMenuPluginProps {
  /** Called when bullet is shift+clicked (for sidebar) */
  onOpenInSidebar?: (blockId: string) => void;
  /** Called when bullet is clicked (for navigation) */
  onNavigateToNode?: (blockId: string) => void;
  /** Called when "Edit link" is chosen from the pill context menu */
  onPillEdit?: (linkId: string, refType: InlineLinkRefType, url?: string, label?: string) => void;
  /** Called when "Delete link" is chosen from the pill context menu */
  onPillRemove?: (linkId: string) => void;
}

interface ContextMenuState {
  position: { x: number; y: number };
  blockId: string;
  isPage: boolean;
  /** When set, the menu targets a linked node (pill) rather than the block itself */
  pillLinkId?: string;
  /** Ref type of the pill link */
  pillRefType?: InlineLinkRefType;
  /** URL for URL pills */
  pillUrl?: string;
  /** Custom label for the pill */
  pillLabel?: string;
}

export function ContextMenuPlugin({
  onOpenInSidebar,
  onNavigateToNode,
  onPillEdit,
  onPillRemove,
}: ContextMenuPluginProps): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Find BlockNode from a DOM element
  const findBlockNodeFromElement = useCallback((element: HTMLElement): { blockId: string; nodeType: string } | null => {
    // Walk up to find .node-block
    let current: HTMLElement | null = element;
    while (current && !current.classList.contains('node-block')) {
      current = current.parentElement;
    }
    if (!current) return null;

    const blockId = current.dataset.blockId;
    if (!blockId) return null;

    // Get node type from runtime
    const runtime = getNodeGraphRuntime();
    const node = runtime.getNode(blockId);
    
    return {
      blockId,
      nodeType: node?.nodeType || 'block',
    };
  }, []);

  // Handle collapse arrow click
  const handleCollapseClick = useCallback((blockId: string) => {
    editor.update(() => {
      const root = $getRoot();
      const children = root.getChildren();
      
      for (const child of children) {
        if ($isBlockNode(child) && child.getBlockId() === blockId) {
          const runtime = getNodeGraphRuntime();
          const currentCollapsed = child.getCollapsed();
          runtime.applyIntent({
            type: 'set_collapsed',
            blockId,
            collapsed: !currentCollapsed,
          });
          break;
        }
      }
    });
  }, [editor]);

  // Handle bullet click (navigation)
  const handleBulletClick = useCallback((blockId: string, shiftKey: boolean) => {
    if (shiftKey && onOpenInSidebar) {
      onOpenInSidebar(blockId);
    } else if (onNavigateToNode) {
      onNavigateToNode(blockId);
    }
  }, [onOpenInSidebar, onNavigateToNode]);

  // Handle context menu (right-click)
  const handleContextMenu = useCallback((blockId: string, x: number, y: number) => {
    const runtime = getNodeGraphRuntime();
    const node = runtime.getNode(blockId);
    
    setContextMenu({
      position: { x, y },
      blockId,
      isPage: node?.isPage === true,
    });
  }, []);

  // Close context menu
  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Register DOM event listeners
  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      
      // Check if clicking on collapse arrow
      if (target.closest('.bullet-collapse-arrow')) {
        event.preventDefault();
        event.stopPropagation();
        
        const blockInfo = findBlockNodeFromElement(target);
        if (blockInfo) {
          handleCollapseClick(blockInfo.blockId);
        }
        return;
      }
      
      // Check if clicking on bullet (check the whole bullet area)
      if (target.closest('.bullet-wrapper')) {
        event.preventDefault();
        event.stopPropagation();
        
        const blockInfo = findBlockNodeFromElement(target);
        if (blockInfo) {
          handleBulletClick(blockInfo.blockId, event.shiftKey);
        }
        return;
      }
    };

    const handleRightClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      
      // Handle right-click on pill (node link)
      const pillWrapper = target.closest('.inline-link-wrapper') as HTMLElement | null;
      if (pillWrapper) {
        const linkId = pillWrapper.getAttribute('data-link-id');
        if (linkId) {
          event.preventDefault();
          event.stopPropagation();
          const refType = (pillWrapper.getAttribute('data-ref-type') as InlineLinkRefType) || 'node';
          const pillUrl = pillWrapper.getAttribute('data-url') || undefined;
          const pillLabel = pillWrapper.getAttribute('data-label') || undefined;
          setContextMenu({
            position: { x: event.clientX, y: event.clientY },
            blockId: linkId,
            isPage: false,
            pillLinkId: linkId,
            pillRefType: refType,
            pillUrl,
            pillLabel,
          });
        }
        return;
      }

      // Handle right-click on bullet area
      if (target.closest('.bullet-wrapper')) {
        event.preventDefault();
        event.stopPropagation();
        
        const blockInfo = findBlockNodeFromElement(target);
        if (blockInfo) {
          const bullet = target.closest('.bullet-wrapper') as HTMLElement;
          const rect = bullet.getBoundingClientRect();
          handleContextMenu(blockInfo.blockId, rect.left, rect.bottom + 4);
        }
      }
    };

    rootElement.addEventListener('click', handleClick, true);
    rootElement.addEventListener('contextmenu', handleRightClick, true);

    return () => {
      rootElement.removeEventListener('click', handleClick, true);
      rootElement.removeEventListener('contextmenu', handleRightClick, true);
    };
  }, [editor, findBlockNodeFromElement, handleCollapseClick, handleBulletClick, handleContextMenu]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;

    const handleClickOutside = () => {
      setContextMenu(null);
    };

    // Delay to avoid immediate close
    const timeout = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timeout);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [contextMenu]);

  // Replace a pill with the target node's name AST (text + preserved links)
  const unlinkPillKeepText = useCallback(async (linkId: string) => {
    const { nodeUuid } = parseLinkId(linkId);

    // Resolve the target node's name AST — try runtime first, then API.
    // Only needed when the pill has no custom label.
    let nameAST: ASTDocument | null = null;

    if (nodeUuid) {
      const runtime = getNodeGraphRuntime();
      const runtimeNode = runtime.getNode(nodeUuid);
      if (runtimeNode) {
        nameAST = runtimeNode.contentAST;
      } else {
        try {
          const apiNode = await getNodeByUuid(nodeUuid);
          nameAST = parseAST(apiNode.name);
        } catch {
          // node not found — fall through to label/uuid fallback
        }
      }
    }

    editor.update(() => {
      const root = $getRoot();
      const findAndExpand = (parent: ReturnType<typeof $getRoot>): boolean => {
        for (const child of parent.getChildren()) {
          if ($isInlineLinkNode(child) && child.getLinkId() === linkId) {
            const replacements: LexicalNode[] = [];

            // Custom label takes priority over the target node's name AST.
            const customLabel = child.getLabel();
            if (customLabel) {
              replacements.push($createTextNode(customLabel));
            } else if (nameAST && nameAST.length > 0) {
              for (const para of nameAST) {
                if ('children' in para) {
                  for (const inline of para.children) {
                    collectInlineReplacements(inline, replacements);
                  }
                }
              }
            }

            if (replacements.length === 0) {
              // Final fallback: uuid or raw link id
              replacements.push($createTextNode(nodeUuid || linkId));
            }

            for (const node of replacements) {
              child.insertBefore(node);
            }
            child.remove();
            return true;
          }
          if ('getChildren' in child && typeof child.getChildren === 'function') {
            if (findAndExpand(child as any)) return true;
          }
        }
        return false;
      };
      findAndExpand(root);
    });

    onPillRemove?.(linkId);
  }, [editor, onPillRemove]);

  // Remove a pill by linkId from the Lexical tree
  const removePillByLinkId = useCallback((linkId: string) => {
    editor.update(() => {
      const root = $getRoot();
      const findAndRemove = (parent: ReturnType<typeof $getRoot>): boolean => {
        for (const child of parent.getChildren()) {
          if ($isInlineLinkNode(child) && child.getLinkId() === linkId) {
            child.remove();
            return true;
          }
          if ('getChildren' in child && typeof child.getChildren === 'function') {
            if (findAndRemove(child as any)) return true;
          }
        }
        return false;
      };
      findAndRemove(root);
    });
  }, [editor]);

  // Build link context menu items
  const linkMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu?.pillLinkId) return [];
    const linkId = contextMenu.pillLinkId;
    const refType = contextMenu.pillRefType || 'node';
    const pillUrl = contextMenu.pillUrl;
    const pillLabel = contextMenu.pillLabel;
    return [
      {
        id: 'edit-link',
        label: 'Edit link',
        icon: mdiPencilOutline,
        onClick: () => {
          onPillEdit?.(linkId, refType, pillUrl, pillLabel);
          handleCloseContextMenu();
        },
      },
      {
        id: 'unlink-keep-text',
        label: 'Unlink (keep text)',
        icon: mdiLinkVariantOff,
        onClick: () => {
          unlinkPillKeepText(linkId);
          handleCloseContextMenu();
        },
      },
      {
        id: 'delete-link',
        label: 'Delete link',
        icon: mdiTrashCanOutline,
        danger: true,
        onClick: () => {
          removePillByLinkId(linkId);
          onPillRemove?.(linkId);
          handleCloseContextMenu();
        },
      },
    ];
  }, [contextMenu, onPillEdit, onPillRemove, handleCloseContextMenu, removePillByLinkId, unlinkPillKeepText]);

  // Render context menu
  if (!contextMenu) return null;

  // For pill context menus, show link-specific Edit / Delete menu
  if (contextMenu.pillLinkId) {
    return (
      <ContextMenu
        items={linkMenuItems}
        position={contextMenu.position}
        onClose={handleCloseContextMenu}
      />
    );
  }

  // For block context menus, use the runtime data
  const runtime = getNodeGraphRuntime();
  const graphNode = runtime.getNode(contextMenu.blockId);
  
  if (!graphNode) return null;

  // Convert GraphNode to API Node format for context menu components
  const apiNode: Node = {
    id: graphNode.serverId || 0,
    uuid: graphNode.blockId,
    name: graphNode.contentAST ? serializeContentAST(graphNode.contentAST) : '',
    is_page: graphNode.isPage,
    collapsed: graphNode.collapsed || false,
    icon: graphNode.icon || null,
    color: graphNode.color || null,
    parent_id: null,
    page_id: null,
    sequence: 0,
    active: true,
    create_date: graphNode.createdAt || '',
    write_date: graphNode.updatedAt || '',
  };

  return contextMenu.isPage ? (
    <PageContextMenu
      node={apiNode}
      position={contextMenu.position}
      onClose={handleCloseContextMenu}
    />
  ) : (
    <BlockContextMenu
      node={apiNode}
      position={contextMenu.position}
      onClose={handleCloseContextMenu}
    />
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Recursively collect Lexical nodes from an AST inline node.
 *
 * - Text/code → TextNode (with format)
 * - hard_break → LineBreakNode
 * - node_link → InlineLinkNode with a fresh linkUuid (new link instance in
 *   this block), same target nodeUuid
 * - Formatting wrappers (strong/em/etc.) → recurse, pass format bits down
 */
function collectInlineReplacements(
  inline: ASTInlineNode,
  out: LexicalNode[],
  format = 0,
): void {
  switch (inline.type) {
    case 'text': {
      if (inline.text) {
        const node = $createTextNode(inline.text);
        if (format !== 0) node.setFormat(format);
        out.push(node);
      }
      break;
    }
    case 'code': {
      const node = $createTextNode(inline.text);
      node.setFormat(format | 16); // IS_CODE
      out.push(node);
      break;
    }
    case 'hard_break':
      out.push($createLineBreakNode());
      break;
    case 'node_link': {
      const { nodeUuid: targetUuid } = parseLinkId(inline.link_id);
      if (targetUuid) {
        const newLinkId = buildLinkId(targetUuid, generateUUID());
        out.push($createInlineLinkNode(newLinkId, inline.ref_type, undefined, inline.label ?? undefined));
      }
      break;
    }
    case 'strong':
      for (const c of inline.children) collectInlineReplacements(c, out, format | 1);
      break;
    case 'em':
      for (const c of inline.children) collectInlineReplacements(c, out, format | 2);
      break;
    case 'underline':
      for (const c of inline.children) collectInlineReplacements(c, out, format | 8);
      break;
    case 'strikethrough':
      for (const c of inline.children) collectInlineReplacements(c, out, format | 4);
      break;
    case 'highlight':
      for (const c of inline.children) collectInlineReplacements(c, out, format);
      break;
    default:
      break;
  }
}
