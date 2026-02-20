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
import { createPortal } from 'react-dom';
import { WhiteboardCanvas } from './WhiteboardCanvas';
import { WhiteboardToolbar } from './WhiteboardToolbar';
import { WhiteboardContextMenu } from './WhiteboardContextMenu';
import { WhiteboardMinimap } from './WhiteboardMinimap';
import { useWhiteboard } from '@/hooks/useWhiteboard';
import { useCreateNode } from '@/hooks/useNodes';
import { useAppStore } from '@/stores/appStore';
import { SearchBox } from '@/components/core/SearchBox';
import { Card } from '@/components/core/Card';
import type { Node } from '@/types/api';
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

  // Reference card search popup state
  const [refCardSearch, setRefCardSearch] = useState<{
    /** Screen position where the card should be placed */
    screenX: number;
    screenY: number;
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
      openNode(cardEl.nodeId);
    }
  }, [wb.data.elements, openNode]);

  // ─── Helpers: screen → canvas coordinate conversion ───────────────

  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    const containerRect = document.querySelector('.whiteboard-view__canvas')?.getBoundingClientRect();
    const canvasX = containerRect
      ? (screenX - containerRect.left - wb.data.viewport.x) / wb.data.viewport.zoom
      : screenX;
    const canvasY = containerRect
      ? (screenY - containerRect.top - wb.data.viewport.y) / wb.data.viewport.zoom
      : screenY;
    return { x: canvasX, y: canvasY };
  }, [wb.data.viewport]);

  const viewportCenter = useCallback(() => {
    const centerX = (-wb.data.viewport.x + window.innerWidth / 2) / wb.data.viewport.zoom;
    const centerY = (-wb.data.viewport.y + window.innerHeight / 2) / wb.data.viewport.zoom;
    return { x: centerX, y: centerY };
  }, [wb.data.viewport]);

  // ─── Add normal card (create a new child block + card element) ────

  const handleAddCard = useCallback(() => {
    createNode.mutate(
      { name: '', parent_id: nodeId },
      {
        onSuccess: (newNode) => {
          const center = viewportCenter();
          const card = wb.createCard(newNode.id, newNode.uuid, { x: center.x - 140, y: center.y - 90 });
          wb.addElement(card);
          wb.selectElements([card.id]);
        },
      }
    );
  }, [nodeId, createNode, wb, viewportCenter]);

  const handleAddCardAtPosition = useCallback((screenX: number, screenY: number) => {
    createNode.mutate(
      { name: '', parent_id: nodeId },
      {
        onSuccess: (newNode) => {
          const pos = screenToCanvas(screenX, screenY);
          const card = wb.createCard(newNode.id, newNode.uuid, pos);
          wb.addElement(card);
          wb.selectElements([card.id]);
        },
      }
    );
  }, [nodeId, createNode, wb, screenToCanvas]);

  // ─── Add reference card (pick existing node → embed as read-only) ─

  const handleAddReferenceCard = useCallback(() => {
    const center = viewportCenter();
    setRefCardSearch({ screenX: center.x, screenY: center.y });
  }, [viewportCenter]);

  const handleAddReferenceCardAtPosition = useCallback((screenX: number, screenY: number) => {
    // Convert screen → canvas for where the card goes; SearchBox position stays screen coords
    setRefCardSearch({ screenX, screenY });
  }, []);

  const handleRefNodeSelected = useCallback((selectedNode: Node) => {
    if (!refCardSearch) return;

    // Create a child block whose name is a link to the selected node: [[nodeUuid]]
    const linkName = `[[${selectedNode.uuid}]]`;
    createNode.mutate(
      { name: linkName, parent_id: nodeId },
      {
        onSuccess: (newBlock) => {
          // Place card at the stored position (already canvas coords for center,
          // or needs conversion for screen coords from context menu)
          let pos: { x: number; y: number };
          // If we came from the toolbar (center), coords are already canvas.
          // If from context menu, we stored raw screen coords.
          const containerRect = document.querySelector('.whiteboard-view__canvas')?.getBoundingClientRect();
          if (containerRect && (refCardSearch.screenX > containerRect.right || refCardSearch.screenY > containerRect.bottom)) {
            // Toolbar click — already canvas coords
            pos = { x: refCardSearch.screenX - 200, y: refCardSearch.screenY - 160 };
          } else {
            pos = screenToCanvas(refCardSearch.screenX, refCardSearch.screenY);
          }

          const card = wb.createReferenceCard(newBlock.id, selectedNode.uuid, pos);
          wb.addElement(card);
          wb.selectElements([card.id]);
        },
      }
    );
    setRefCardSearch(null);
  }, [refCardSearch, nodeId, createNode, wb, screenToCanvas]);

  // ─── Add image ────────────────────────────────────────────────────

  const handleAddImage = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        const center = viewportCenter();

        const imageEl = {
          id: createElementId(),
          type: 'image' as const,
          x: center.x - 150,
          y: center.y - 100,
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
  }, [wb, viewportCenter]);

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

    const baseGrid  = wb.data.grid.size;          // world-space grid
    const zoom      = wb.data.viewport.zoom;
    const TARGET_PX = 48;                          // ideal screen-px spacing

    // Power-of-2 snap: pick multiplier so (baseGrid * mult * zoom) ≈ TARGET_PX
    const raw  = TARGET_PX / (baseGrid * zoom);
    const mult = Math.pow(2, Math.round(Math.log2(Math.max(raw, 1 / 256))));
    const gridSize = Math.max(baseGrid * mult * zoom, 16); // floor at 16px

    // Dot radius scales inversely with gridSize so dots stay visible
    const dotRadius = Math.min(1.5, Math.max(0.8, 1.5 * (48 / gridSize)));

    return {
      backgroundSize: `${gridSize}px ${gridSize}px`,
      '--grid-offset-x': `${wb.data.viewport.x % gridSize}px`,
      '--grid-offset-y': `${wb.data.viewport.y % gridSize}px`,
      '--grid-dot-radius': `${dotRadius}px`,
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
        onAddReferenceCard={handleAddReferenceCard}
        onAddImage={handleAddImage}
      />

      {/* Minimap */}
      <WhiteboardMinimap wb={wb} />

      {/* Context menu — rendered via portal to escape transform: translateZ(0) on .whiteboard-view,
          which would otherwise offset position:fixed coordinates */}
      {contextMenu && createPortal(
        <WhiteboardContextMenu
          wb={wb}
          position={contextMenu.position}
          elementId={contextMenu.elementId}
          onClose={closeContextMenu}
          onOpenNode={handleOpenNode}
          onAddCardAtPosition={handleAddCardAtPosition}
          onAddReferenceCardAtPosition={handleAddReferenceCardAtPosition}
        />,
        document.body
      )}

      {/* Reference card node search popup */}
      {refCardSearch && (
        <div className="whiteboard-ref-search-overlay" onClick={() => setRefCardSearch(null)}>
          <div
            className="whiteboard-ref-search-popup"
            onClick={(e) => e.stopPropagation()}
          >
            <Card elevation="high" variant="filled" padding paddingSize="sm">
              <div style={{ marginBottom: 8, fontWeight: 600, fontSize: 13 }}>
                Select node to reference
              </div>
              <SearchBox
                placeholder="Search pages..."
                autoFocus
                filterFn={(n: Node) => n.is_page && n.id !== nodeId}
                onSelect={handleRefNodeSelected}
              />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
};
