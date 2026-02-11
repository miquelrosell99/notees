/**
 * ContextMenuPlugin — Handles bullet interactions and context menus.
 *
 * Features:
 * - Click on collapse arrow: toggle collapsed state
 * - Right-click on bullet: show context menu
 * - Shift+click on bullet: open in sidebar
 * - Click on bullet: navigate to focused view
 */

import { useState, useEffect, useCallback, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';

import { $isNodeBlockNode } from '../nodes/NodeBlockNode';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
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
}

export function ContextMenuPlugin({
  onOpenInSidebar,
  onNavigateToNode,
}: ContextMenuPluginProps): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Find NodeBlockNode from a DOM element
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
        if ($isNodeBlockNode(child) && child.getBlockId() === blockId) {
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
      if (target.closest('.node-block-collapse-arrow')) {
        event.preventDefault();
        event.stopPropagation();
        
        const blockInfo = findBlockNodeFromElement(target);
        if (blockInfo) {
          handleCollapseClick(blockInfo.blockId);
        }
        return;
      }
      
      // Check if clicking on bullet (dot or container)
      if (target.closest('.node-block-bullet-container') || target.closest('.node-block-dot') || target.closest('.node-block-icon')) {
        event.preventDefault();
        event.stopPropagation();
        
        const blockInfo = findBlockNodeFromElement(target);
        if (blockInfo) {
          handleBulletClick(blockInfo.blockId, event.shiftKey);
        }
        return;
      }
      
      // Check if clicking on empty area of a node-block (for empty blocks)
      // This helps focus empty blocks that have no text content to click on
      const nodeBlock = target.closest('.node-block') as HTMLElement;
      if (nodeBlock && target === nodeBlock) {
        const blockInfo = findBlockNodeFromElement(target);
        if (blockInfo) {
          // Focus the block content
          editor.update(() => {
            const root = $getRoot();
            const children = root.getChildren();
            for (const child of children) {
              if ($isNodeBlockNode(child) && child.getBlockId() === blockInfo.blockId) {
                const firstChild = child.getFirstChild();
                if (firstChild) {
                  firstChild.selectStart();
                }
                break;
              }
            }
          });
        }
      }
    };

    const handleRightClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      
      // Only handle right-click on bullet area
      if (target.closest('.node-block-bullet')) {
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

  // Render context menu
  if (!contextMenu) return null;

  // Get node data for context menu
  const runtime = getNodeGraphRuntime();
  const graphNode = runtime.getNode(contextMenu.blockId);
  
  if (!graphNode) return null;

  // Convert GraphNode to API Node format for context menu components
  const apiNode: Node = {
    id: graphNode.serverId || 0,
    uuid: graphNode.blockId,
    name: JSON.stringify(graphNode.contentAST),
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
