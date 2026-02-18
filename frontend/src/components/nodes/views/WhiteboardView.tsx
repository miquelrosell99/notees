/**
 * WhiteboardView — Main whiteboard view component.
 *
 * This is the top-level component rendered when a whiteboard node is displayed.
 * It orchestrates the canvas, toolbar, context menu, and node/block management.
 *
 * Architecture follows the same patterns as GraphView:
 * - FloatingButtonArray for toolbar groups
 * - ButtonWithPanel for settings panels
 * - ContextMenu for right-click menus
 * - Card for panels and floating UI
 */
import React, { useState, useCallback, useMemo } from 'react';
import { WhiteboardCanvas } from './WhiteboardCanvas';
import { WhiteboardToolbar } from './WhiteboardToolbar';
import { WhiteboardContextMenu } from './WhiteboardContextMenu';
import { WhiteboardMinimap } from './WhiteboardMinimap';
import { useWhiteboard } from '@/hooks/useWhiteboard';
import { useCreateNode } from '@/hooks/useNodes';
import { useAppStore } from '@/stores/appStore';
import type { WhiteboardCardElement } from '@/types/whiteboard';
import { createElementId } from '@/types/whiteboard';
import './WhiteboardView.css';

interface WhiteboardViewProps {
  nodeId: number;
  nodeUuid: string;
}

export const WhiteboardView: React.FC<WhiteboardViewProps> = ({ nodeId }) => {
  const wb = useWhiteboard(nodeId);
  const createNode = useCreateNode();
  const openNode = useAppStore(s => s.openNode);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    elementId: string | null;
  } | null>(null);

  // ─── Context menu handler ─────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent, elementId?: string) => {
    setContextMenu({
      position: { x: e.clientX, y: e.clientY },
      elementId: elementId ?? null,
    });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // ─── Double-click handler (open card nodes) ───────────────────────

  const handleDoubleClick = useCallback((elementId: string) => {
    const el = wb.data.elements.find(e => e.id === elementId);
    if (el?.type === 'card') {
      const cardEl = el as WhiteboardCardElement;
      // Navigate to the node
      openNode(cardEl.nodeId);
    }
  }, [wb.data.elements, openNode]);

  // ─── Add card (create a new child block + card element) ───────────

  const handleAddCard = useCallback(() => {
    // Create a new block as a child of the whiteboard
    createNode.mutate(
      {
        name: '',
        parent_id: nodeId,
      },
      {
        onSuccess: (newNode) => {
          // Add a card element at the center of the viewport
          const centerX = (-wb.data.viewport.x + window.innerWidth / 2) / wb.data.viewport.zoom - 140;
          const centerY = (-wb.data.viewport.y + window.innerHeight / 2) / wb.data.viewport.zoom - 90;

          const card = wb.createCard(newNode.id, newNode.uuid, { x: centerX, y: centerY });
          wb.addElement(card);
          wb.selectElements([card.id]);
        },
      }
    );
  }, [nodeId, createNode, wb]);

  const handleAddCardAtPosition = useCallback((screenX: number, screenY: number) => {
    createNode.mutate(
      {
        name: '',
        parent_id: nodeId,
      },
      {
        onSuccess: (newNode) => {
          // Convert screen position to canvas position
          const containerRect = document.querySelector('.whiteboard-view__canvas')?.getBoundingClientRect();
          const canvasX = containerRect
            ? (screenX - containerRect.left - wb.data.viewport.x) / wb.data.viewport.zoom
            : screenX;
          const canvasY = containerRect
            ? (screenY - containerRect.top - wb.data.viewport.y) / wb.data.viewport.zoom
            : screenY;

          const card = wb.createCard(newNode.id, newNode.uuid, { x: canvasX, y: canvasY });
          wb.addElement(card);
          wb.selectElements([card.id]);
        },
      }
    );
  }, [nodeId, createNode, wb]);

  // ─── Add image ────────────────────────────────────────────────────

  const handleAddImage = useCallback(() => {
    // Create a file input to select an image
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        const centerX = (-wb.data.viewport.x + window.innerWidth / 2) / wb.data.viewport.zoom - 150;
        const centerY = (-wb.data.viewport.y + window.innerHeight / 2) / wb.data.viewport.zoom - 100;

        const imageEl = {
          id: createElementId(),
          type: 'image' as const,
          x: centerX,
          y: centerY,
          width: 300,
          height: 200,
          rotation: 0,
          locked: false,
          opacity: 1,
          zIndex: Math.max(...wb.data.elements.map(el => el.zIndex), 0) + 1,
          src: dataUrl,
          objectFit: 'contain' as const,
          borderRadius: 4,
        };
        wb.addElement(imageEl);
        wb.selectElements([imageEl.id]);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }, [wb]);

  // ─── Open referenced node ────────────────────────────────────────

  const handleOpenNode = useCallback((nodeId: number) => {
    openNode(nodeId);
  }, [openNode]);

  // ─── Grid class ──────────────────────────────────────────────────

  const viewClassName = useMemo(() => {
    return `whiteboard-view ${wb.data.grid.visible ? 'whiteboard-view--grid' : ''}`;
  }, [wb.data.grid.visible]);

  const gridStyle = useMemo(() => {
    if (!wb.data.grid.visible) return {};
    const gridSize = wb.data.grid.size * wb.data.viewport.zoom;
    return {
      backgroundSize: `${gridSize}px ${gridSize}px`,
      '--grid-offset-x': `${wb.data.viewport.x % gridSize}px`,
      '--grid-offset-y': `${wb.data.viewport.y % gridSize}px`,
    } as React.CSSProperties;
  }, [wb.data.grid, wb.data.viewport]);

  return (
    <div className={viewClassName} style={gridStyle}>
      {/* Canvas */}
      <WhiteboardCanvas
        wb={wb}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
      />

      {/* Toolbar */}
      <WhiteboardToolbar
        wb={wb}
        onAddCard={handleAddCard}
        onAddImage={handleAddImage}
      />

      {/* Minimap */}
      <WhiteboardMinimap wb={wb} />

      {/* Context menu */}
      {contextMenu && (
        <WhiteboardContextMenu
          wb={wb}
          position={contextMenu.position}
          elementId={contextMenu.elementId}
          onClose={closeContextMenu}
          onOpenNode={handleOpenNode}
          onAddCardAtPosition={handleAddCardAtPosition}
        />
      )}
    </div>
  );
};
