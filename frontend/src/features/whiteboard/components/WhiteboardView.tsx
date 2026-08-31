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
import { Button } from '@/components/ui/Button';
import { useWhiteboard } from '@/features/whiteboard/hooks/useWhiteboard';
import { useCreateNode, useDeleteNode } from '@/features/content';
import { useNavigationStore } from '@/stores';
import { useWhiteboardViewSettings } from '@/features/whiteboard/hooks/useWhiteboardSelectors';
import { LinkEditModal, type LinkEditResult } from '@/features/editor';
import type { WhiteboardCardElement } from '@/features/whiteboard/types/whiteboard';
import { createElementId } from '@/features/whiteboard/types/whiteboard';
import { inlineDoc, nodeLink, buildLinkId } from '@/lib/astBuilder';
import { generateUUID } from '@/utils/uuid';
import './WhiteboardView.css';

interface WhiteboardViewProps {
  nodeUuid: string;
  /**
   * Inline presentation (Decision 24): a block with the `whiteboard` class
   * renders the same canvas as a bounded card inside the document flow.
   * Adds an expand affordance (opens the full view) and hides the minimap.
   */
  inline?: boolean;
}

export const WhiteboardView: React.FC<WhiteboardViewProps> = ({ nodeUuid, inline = false }) => {
  const wb = useWhiteboard(nodeUuid);
  const createNode = useCreateNode();
  const deleteNode = useDeleteNode();
  const openNode = useNavigationStore(s => s.openNode);
  const { gridVisible, gridSize, minimapVisible } = useWhiteboardViewSettings();

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    elementId: string | null;
  } | null>(null);

  // Reference card modal state — stores canvas coords where the card will be placed
  const [refCardPos, setRefCardPos] = useState<{ x: number; y: number } | null>(null);

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
      openNode(cardEl.nodeUuid);
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
      { name: '', parent_uuid: nodeUuid },
      {
        onSuccess: (newNode) => {
          const center = viewportCenter();
          const card = wb.createCard(newNode.uuid, { x: center.x - 140, y: center.y - 90 });
          wb.addElement(card);
          wb.selectElements([card.id]);
        },
      }
    );
  }, [nodeUuid, createNode, wb, viewportCenter]);

  const handleAddCardAtPosition = useCallback((screenX: number, screenY: number) => {
    createNode.mutate(
      { name: '', parent_uuid: nodeUuid },
      {
        onSuccess: (newNode) => {
          const pos = screenToCanvas(screenX, screenY);
          const card = wb.createCard(newNode.uuid, pos);
          wb.addElement(card);
          wb.selectElements([card.id]);
        },
      }
    );
  }, [nodeUuid, createNode, wb, screenToCanvas]);

  // ─── Add reference card (pick existing node via LinkEditModal → embed as read-only) ─

  const handleAddReferenceCard = useCallback(() => {
    const center = viewportCenter();
    setRefCardPos({ x: center.x - 200, y: center.y - 160 });
  }, [viewportCenter]);

  const handleAddReferenceCardAtPosition = useCallback((screenX: number, screenY: number) => {
    setRefCardPos(screenToCanvas(screenX, screenY));
  }, [screenToCanvas]);

  const handleRefCardSave = useCallback((result: LinkEditResult) => {
    if (!refCardPos || result.mode !== 'node' || !result.targetNode) {
      setRefCardPos(null);
      return;
    }

    const selectedNode = result.targetNode;
    // Create a hidden child block whose name is a proper AST node_link to the selected node.
    // The card itself displays the referenced node (selectedNode), not this block.
    const linkUuid = generateUUID();
    const ast = inlineDoc(nodeLink(buildLinkId(selectedNode.uuid, linkUuid)));
    const linkName = JSON.stringify(ast);
    createNode.mutate(
      { name: linkName, parent_uuid: nodeUuid },
      {
        onSuccess: (newBlock) => {
          // nodeUuid = referenced node (display), refBlockUuid = hidden block (cleanup on delete)
          const card = wb.createReferenceCard(selectedNode.uuid, refCardPos, newBlock.uuid);
          wb.addElement(card);
          wb.selectElements([card.id]);
        },
      }
    );
    setRefCardPos(null);
  }, [refCardPos, nodeUuid, createNode, wb]);

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

  // ─── Remove elements and clean up ref blocks ────────────────────

  const wbWrapped = useMemo(() => ({
    ...wb,
    removeElements: (ids: string[]) => {
      // For reference cards, delete the hidden block that holds the node_link
      ids.forEach(id => {
        const el = wb.data.elements.find(e => e.id === id);
        if (el?.type === 'card' && (el as WhiteboardCardElement).cardMode === 'reference') {
          const refBlockUuid = (el as WhiteboardCardElement).refBlockUuid;
          if (refBlockUuid) {
            deleteNode.mutate(refBlockUuid);
          }
        }
      });
      wb.removeElements(ids);
    },
  }), [wb, deleteNode]);

  // ─── Open referenced node ────────────────────────────────────────

  const handleOpenNode = useCallback((nodeUuid: string) => {
    openNode(nodeUuid);
  }, [openNode]);

  // ─── Grid class ──────────────────────────────────────────────────

  const viewClassName = useMemo(() => {
    return `whiteboard-view ${gridVisible ? 'whiteboard-view--grid' : ''} ${inline ? 'whiteboard-view--inline' : ''}`;
  }, [gridVisible, inline]);

  const gridStyle = useMemo(() => {
    if (!gridVisible) return {};

    const baseGrid  = gridSize;                   // world-space grid
    const zoom      = wb.data.viewport.zoom;
    const TARGET_PX = 48;                          // ideal screen-px spacing

    // Power-of-2 snap: pick multiplier so (baseGrid * mult * zoom) ≈ TARGET_PX
    const raw  = TARGET_PX / (baseGrid * zoom);
    const mult = Math.pow(2, Math.round(Math.log2(Math.max(raw, 1 / 256))));
    const screenGridSize = Math.max(baseGrid * mult * zoom, 16); // floor at 16px

    // Dot radius scales inversely with screenGridSize so dots stay visible
    const dotRadius = Math.min(1.5, Math.max(0.8, 1.5 * (48 / screenGridSize)));

    return {
      backgroundSize: `${screenGridSize}px ${screenGridSize}px`,
      '--grid-offset-x': `${wb.data.viewport.x % screenGridSize}px`,
      '--grid-offset-y': `${wb.data.viewport.y % screenGridSize}px`,
      '--grid-dot-radius': `${dotRadius}px`,
    } as React.CSSProperties;
  }, [gridVisible, gridSize, wb.data.viewport]);

  return (
    <div className={viewClassName} style={gridStyle}>
      {/* Canvas */}
      <WhiteboardCanvas
        wb={wbWrapped}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
      />

      {/* Toolbar */}
      <WhiteboardToolbar
        wb={wbWrapped}
        onAddCard={handleAddCard}
        onAddReferenceCard={handleAddReferenceCard}
        onAddImage={handleAddImage}
      />

      {/* Minimap — hidden inline; the card is too small for it to be useful */}
      {minimapVisible && !inline && <WhiteboardMinimap wb={wbWrapped} />}

      {/* Expand affordance — inline cards open the full-page canvas view */}
      {inline && (
        <Button
          variant="ghost"
          size="xs"
          icon="mdi mdi-arrow-expand"
          aria-label="Open full whiteboard"
          title="Open full whiteboard"
          className="whiteboard-view__expand-btn"
          onClick={() => openNode(nodeUuid)}
        />
      )}

      {/* Context menu — rendered via portal to escape transform: translateZ(0) on .whiteboard-view,
          which would otherwise offset position:fixed coordinates */}
      {contextMenu && createPortal(
        <WhiteboardContextMenu
          wb={wbWrapped}
          position={contextMenu.position}
          elementId={contextMenu.elementId}
          onClose={closeContextMenu}
          onOpenNode={handleOpenNode}
          onAddCardAtPosition={handleAddCardAtPosition}
          onAddReferenceCardAtPosition={handleAddReferenceCardAtPosition}
        />,
        document.body
      )}

      {/* Reference card node picker — uses LinkEditModal in node mode */}
      {refCardPos && (
        <LinkEditModal
          isOpen={true}
          linkId=""
          refType="node"
          title="Add Reference Card"
          hideUrlMode
          onSave={handleRefCardSave}
          onClose={() => setRefCardPos(null)}
        />
      )}
    </div>
  );
};
