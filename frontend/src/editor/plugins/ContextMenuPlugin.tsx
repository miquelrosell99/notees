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
import { $getRoot } from 'lexical';

import { $isBlockNode } from '../nodes/BlockNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { serializeContentAST } from '../BlockEditor';
import { useNodeByUuid } from '../../hooks/useNodeQueries';
import { parseLinkId } from '../../lib/astBuilder';
import { PageContextMenu, BlockContextMenu } from '../../components/nodes/NodeContextMenu';
import type { Node } from '../../types/api';

export interface ContextMenuPluginProps {
  /** Called when bullet is shift+clicked (for sidebar) */
  onOpenInSidebar?: (blockId: string) => void;
  /** Called when bullet is clicked (for navigation) */
  onNavigateToNode?: (blockId: string) => void;
}

interface ContextMenuState {
  position: { x: number; y: number };
  blockId: string;
  isPage: boolean;
  /** When set, the menu targets a linked node (pill) rather than the block itself */
  pillLinkId?: string;
}

export function ContextMenuPlugin({
  onOpenInSidebar,
  onNavigateToNode,
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
      const pillWrapper = target.closest('.node-pill-wrapper') as HTMLElement | null;
      if (pillWrapper) {
        const linkId = pillWrapper.getAttribute('data-link-id');
        if (linkId) {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({
            position: { x: event.clientX, y: event.clientY },
            blockId: linkId,
            isPage: false, // will be resolved from fetched data
            pillLinkId: linkId,
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
          handleContextMenu(blockInfo.blockId, event.clientX, event.clientY);
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

  // Fetch linked node data when showing a pill context menu
  const pillLinkId = contextMenu?.pillLinkId ?? null;
  const pillNodeUuid = useMemo(() => {
    if (!pillLinkId) return null;
    return parseLinkId(pillLinkId).nodeUuid;
  }, [pillLinkId]);
  const { data: pillNode } = useNodeByUuid(pillNodeUuid);

  // Render context menu
  if (!contextMenu) return null;

  // For pill context menus, use the fetched node data
  if (contextMenu.pillLinkId) {
    if (!pillNode) return null; // still loading

    return pillNode.is_page ? (
      <PageContextMenu
        node={pillNode}
        position={contextMenu.position}
        onClose={handleCloseContextMenu}
      />
    ) : (
      <BlockContextMenu
        node={pillNode}
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
