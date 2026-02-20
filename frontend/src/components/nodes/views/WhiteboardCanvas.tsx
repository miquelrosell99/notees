/**
 * WhiteboardCanvas — Core rendering engine for whiteboard elements.
 *
 * Handles:
 * - Canvas-to-screen coordinate transforms (pan + zoom)
 * - Element rendering (cards, shapes, strokes, text, connectors, images)
 * - Mouse/touch/stylus interaction dispatching
 * - Drag, resize, rotate operations
 * - Selection box (right-click drag)
 * - Grid rendering
 * - Stroke drawing (pen, highlighter, eraser) with pressure
 */
import React, { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  WhiteboardElement,
  WhiteboardCardElement,
  WhiteboardShapeElement,
  WhiteboardStrokeElement,
  WhiteboardTextElement,
  WhiteboardConnectorElement,
  WhiteboardImageElement,
  Point,
  Bounds,
  ConnectorEndpoint,
} from '@/types/whiteboard';
import { boundsOverlap, isPointInBounds } from '@/types/whiteboard';
import type { UseWhiteboardReturn } from '@/hooks/useWhiteboard';
import { WhiteboardCardRenderer } from './WhiteboardCardRenderer';
import { WhiteboardShapeRenderer } from './WhiteboardShapeRenderer';
import { getShapePath } from './WhiteboardShapeRenderer';
import { WhiteboardStrokeRenderer } from './WhiteboardStrokeRenderer';
import './WhiteboardView.css';

interface WhiteboardCanvasProps {
  wb: UseWhiteboardReturn;
  onContextMenu: (e: React.MouseEvent, elementId?: string) => void;
  onDoubleClick: (elementId: string) => void;
}

// Minimum drag distance before starting a drag/draw operation
const DRAG_THRESHOLD = 3;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;

export const WhiteboardCanvas: React.FC<WhiteboardCanvasProps> = ({
  wb,
  onContextMenu,
  onDoubleClick,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [isEmptyPanning, setIsEmptyPanning] = useState(false);
  // Tracks shift key during shape creation drag for preview re-renders
  const [shiftConstraint, setShiftConstraint] = useState(false);

  // Track pointer state
  const pointerState = useRef({
    isDown: false,
    startScreenPos: { x: 0, y: 0 } as Point,
    startCanvasPos: { x: 0, y: 0 } as Point,
    startElementPositions: new Map<string, Point>(),
    startElementBounds: null as Bounds | null,
    hasDragged: false,
    button: 0,
    pointerId: -1,
    startedOnEmpty: false,
    isEmptyPanning: false,
    lastPanPos: { x: 0, y: 0 } as Point,
    lastCanvasPos: { x: 0, y: 0 } as Point,
    shiftHeld: false,
  });

  const { data, interaction, setInteraction } = wb;
  const { viewport } = data;

  // ─── Coordinate transforms ────────────────────────────────────────

  const screenToCanvas = useCallback((screenX: number, screenY: number): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (screenX - rect.left - viewport.x) / viewport.zoom,
      y: (screenY - rect.top - viewport.y) / viewport.zoom,
    };
  }, [viewport]);

  const canvasToScreen = useCallback((canvasX: number, canvasY: number): Point => {
    return {
      x: canvasX * viewport.zoom + viewport.x,
      y: canvasY * viewport.zoom + viewport.y,
    };
  }, [viewport]);

  // ─── Hit testing ──────────────────────────────────────────────────

  const hitTest = useCallback((canvasPoint: Point): WhiteboardElement | null => {
    // Iterate from top (highest zIndex) to bottom
    const sorted = [...data.elements].sort((a, b) => b.zIndex - a.zIndex);
    for (const el of sorted) {
      if (el.locked) continue;
      const bounds: Bounds = { x: el.x, y: el.y, width: el.width, height: el.height };
      if (isPointInBounds(canvasPoint, bounds)) {
        return el;
      }
    }
    return null;
  }, [data.elements]);

  const hitTestResizeHandle = useCallback((screenX: number, screenY: number, elementId: string): string | null => {
    const el = data.elements.find(e => e.id === elementId);
    if (!el) return null;

    const topLeft = canvasToScreen(el.x, el.y);
    const bottomRight = canvasToScreen(el.x + el.width, el.y + el.height);
    const handleSize = 12;

    const handles = [
      { id: 'nw', x: topLeft.x, y: topLeft.y },
      { id: 'n', x: (topLeft.x + bottomRight.x) / 2, y: topLeft.y },
      { id: 'ne', x: bottomRight.x, y: topLeft.y },
      { id: 'e', x: bottomRight.x, y: (topLeft.y + bottomRight.y) / 2 },
      { id: 'se', x: bottomRight.x, y: bottomRight.y },
      { id: 's', x: (topLeft.x + bottomRight.x) / 2, y: bottomRight.y },
      { id: 'sw', x: topLeft.x, y: bottomRight.y },
      { id: 'w', x: topLeft.x, y: (topLeft.y + bottomRight.y) / 2 },
    ];

    for (const h of handles) {
      if (
        Math.abs(screenX - h.x) < handleSize &&
        Math.abs(screenY - h.y) < handleSize
      ) {
        return h.id;
      }
    }
    return null;
  }, [data.elements, canvasToScreen]);

  // ─── Pointer event handlers ───────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!containerRef.current) return;

    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    const state = pointerState.current;

    state.isDown = true;
    state.startScreenPos = { x: e.clientX, y: e.clientY };
    state.startCanvasPos = canvasPos;
    state.hasDragged = false;
    state.button = e.button;
    state.pointerId = e.pointerId;

    containerRef.current.setPointerCapture(e.pointerId);

    const tool = interaction.tool;

    // Middle-click → pan
    if (e.button === 1) {
      setInteraction(prev => ({ ...prev, isPanning: true, dragStart: { x: e.clientX, y: e.clientY } }));
      return;
    }

    // Right-click → context menu only (handled by onContextMenu); ignore here
    if (e.button === 2) return;

    // Drawing tools
    if (tool === 'pen' || tool === 'highlighter' || tool === 'eraser') {
      const pressure = e.pressure > 0 ? e.pressure : 0.5;
      setInteraction(prev => ({
        ...prev,
        isDrawing: true,
        currentStroke: [{ x: canvasPos.x, y: canvasPos.y, pressure, timestamp: Date.now() }],
      }));
      return;
    }

    // Connector tool
    if (tool === 'connector') {
      const hitElement = hitTest(canvasPos);
      if (hitElement) {
        setInteraction(prev => ({
          ...prev,
          connectorStart: { type: 'element', elementId: hitElement.id, anchor: 'center' },
        }));
      } else {
        setInteraction(prev => ({
          ...prev,
          connectorStart: { type: 'point', x: canvasPos.x, y: canvasPos.y },
        }));
      }
      return;
    }

    // Select tool
    if (tool === 'select') {
      // Check resize handle first
      if (interaction.selectedIds.size === 1) {
        const selectedId = [...interaction.selectedIds][0];
        const handle = hitTestResizeHandle(e.clientX, e.clientY, selectedId);
        if (handle) {
          const el = data.elements.find(el => el.id === selectedId);
          if (el) {
            state.startElementBounds = { x: el.x, y: el.y, width: el.width, height: el.height };
            setInteraction(prev => ({ ...prev, isResizing: true, resizeHandle: handle }));
            return;
          }
        }
      }

      const hitElement = hitTest(canvasPos);
      if (hitElement) {
        // Select or add to selection
        if (e.shiftKey) {
          const newSelected = new Set(interaction.selectedIds);
          if (newSelected.has(hitElement.id)) {
            newSelected.delete(hitElement.id);
          } else {
            newSelected.add(hitElement.id);
          }
          setInteraction(prev => ({ ...prev, selectedIds: newSelected }));
        } else if (!interaction.selectedIds.has(hitElement.id)) {
          setInteraction(prev => ({ ...prev, selectedIds: new Set([hitElement.id]) }));
        }

        // Store starting positions for drag
        const selectedIds = interaction.selectedIds.has(hitElement.id)
          ? interaction.selectedIds
          : new Set([hitElement.id]);
        state.startElementPositions.clear();
        for (const id of selectedIds) {
          const el = data.elements.find(e => e.id === id);
          if (el) state.startElementPositions.set(id, { x: el.x, y: el.y });
        }
      } else {
        // Empty space: Shift+drag → box select, plain drag → pan, plain click → deselect (on up)
        if (e.shiftKey) {
          setInteraction(prev => ({
            ...prev,
            isSelectionBox: true,
            selectionBox: { x: canvasPos.x, y: canvasPos.y, width: 0, height: 0 },
          }));
        } else {
          state.startedOnEmpty = true;
          state.lastPanPos = { x: e.clientX, y: e.clientY };
        }
      }
      return;
    }

    // Shape creation tools
    if (['rectangle', 'ellipse', 'triangle', 'hexagon', 'star'].includes(tool)) {
      setInteraction(prev => ({
        ...prev,
        isDragging: true,
        dragStart: canvasPos,
      }));
      return;
    }

    // Text tool
    if (tool === 'text') {
      const snapped = wb.snapToGrid(canvasPos);
      const textEl = wb.createText(snapped);
      wb.addElement(textEl);
      setEditingTextId(textEl.id);
      wb.setTool('select');
      wb.selectElements([textEl.id]);
      return;
    }

    // Card tool
    if (tool === 'card') {
      // Card creation will be handled by the toolbar (create node + card element)
      return;
    }
  }, [screenToCanvas, hitTest, hitTestResizeHandle, interaction, data.elements, wb, setInteraction]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const state = pointerState.current;
    if (e.pointerId !== state.pointerId && state.isDown) return;

    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    state.lastCanvasPos = canvasPos;

    // Update hover
    if (!state.isDown) {
      const hitElement = hitTest(canvasPos);
      setInteraction(prev => ({
        ...prev,
        hoveredId: hitElement?.id ?? null,
      }));
      return;
    }

    const dx = e.clientX - state.startScreenPos.x;
    const dy = e.clientY - state.startScreenPos.y;

    if (!state.hasDragged && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
    state.hasDragged = true;

    // Empty-space pan (select tool, drag without Shift)
    if (state.startedOnEmpty) {
      const pdx = e.clientX - state.lastPanPos.x;
      const pdy = e.clientY - state.lastPanPos.y;
      state.lastPanPos = { x: e.clientX, y: e.clientY };
      if (!state.isEmptyPanning) {
        state.isEmptyPanning = true;
        setIsEmptyPanning(true);
      }
      wb.setViewport({ x: viewport.x + pdx, y: viewport.y + pdy, zoom: viewport.zoom });
      return;
    }

    // Panning (middle-click)
    if (interaction.isPanning) {
      wb.setViewport({
        x: viewport.x + (e.clientX - (interaction.dragStart?.x ?? 0)),
        y: viewport.y + (e.clientY - (interaction.dragStart?.y ?? 0)),
        zoom: viewport.zoom,
      });
      setInteraction(prev => ({ ...prev, dragStart: { x: e.clientX, y: e.clientY } }));
      return;
    }

    // Selection box
    if (interaction.isSelectionBox) {
      const startPos = state.startCanvasPos;
      const box: Bounds = {
        x: Math.min(startPos.x, canvasPos.x),
        y: Math.min(startPos.y, canvasPos.y),
        width: Math.abs(canvasPos.x - startPos.x),
        height: Math.abs(canvasPos.y - startPos.y),
      };
      // Find elements within selection box
      const selectedIds = new Set<string>();
      for (const el of data.elements) {
        if (el.locked) continue;
        const elBounds: Bounds = { x: el.x, y: el.y, width: el.width, height: el.height };
        if (boundsOverlap(box, elBounds)) {
          selectedIds.add(el.id);
        }
      }
      setInteraction(prev => ({
        ...prev,
        selectionBox: box,
        selectedIds,
      }));
      return;
    }

    // Drawing
    if (interaction.isDrawing) {
      const pressure = e.pressure > 0 ? e.pressure : 0.5;

      // Shift: snap to horizontal, vertical, or 45° diagonal from stroke start
      if (e.shiftKey && interaction.currentStroke.length > 0) {
        const startPoint = interaction.currentStroke[0];
        const rawDx = canvasPos.x - startPoint.x;
        const rawDy = canvasPos.y - startPoint.y;
        const angle = Math.atan2(rawDy, rawDx);
        const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        const dist = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
        const snappedX = startPoint.x + dist * Math.cos(snappedAngle);
        const snappedY = startPoint.y + dist * Math.sin(snappedAngle);
        const newPoint = { x: snappedX, y: snappedY, pressure, timestamp: Date.now() };
        // Replace with [start, snapped] to keep the stroke as a clean straight line
        setInteraction(prev => ({
          ...prev,
          currentStroke: [prev.currentStroke[0], newPoint],
        }));
        return;
      }

      const newPoint = { x: canvasPos.x, y: canvasPos.y, pressure, timestamp: Date.now() };
      setInteraction(prev => {
        const stroke = prev.currentStroke;
        if (stroke.length > 0) {
          const last = stroke[stroke.length - 1];
          const dx = newPoint.x - last.x;
          const dy = newPoint.y - last.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          // Dynamic min-distance: starts at 2px, grows with stroke length to keep
          // the segment count manageable and rendering fast for long strokes.
          const minDist = Math.max(2, Math.min(10, stroke.length * 0.015));
          if (dist < minDist) return prev;
        }
        return { ...prev, currentStroke: [...stroke, newPoint] };
      });
      return;
    }

    // Resizing
    if (interaction.isResizing && interaction.resizeHandle) {
      const selectedId = [...interaction.selectedIds][0];
      const startBounds = state.startElementBounds;
      if (!selectedId || !startBounds) return;

      const canvasDx = canvasPos.x - state.startCanvasPos.x;
      const canvasDy = canvasPos.y - state.startCanvasPos.y;

      let newBounds = { ...startBounds };
      const handle = interaction.resizeHandle;

      if (handle.includes('n')) {
        newBounds.y = startBounds.y + canvasDy;
        newBounds.height = startBounds.height - canvasDy;
      }
      if (handle.includes('s')) {
        newBounds.height = startBounds.height + canvasDy;
      }
      if (handle.includes('w')) {
        newBounds.x = startBounds.x + canvasDx;
        newBounds.width = startBounds.width - canvasDx;
      }
      if (handle.includes('e')) {
        newBounds.width = startBounds.width + canvasDx;
      }

      // Enforce minimum size
      if (newBounds.width < 20) {
        if (handle.includes('w')) newBounds.x = startBounds.x + startBounds.width - 20;
        newBounds.width = 20;
      }
      if (newBounds.height < 20) {
        if (handle.includes('n')) newBounds.y = startBounds.y + startBounds.height - 20;
        newBounds.height = 20;
      }

      if (data.grid.snap) {
        const snapped = wb.snapToGrid({ x: newBounds.x, y: newBounds.y });
        newBounds.x = snapped.x;
        newBounds.y = snapped.y;
      }

      wb.resizeElement(selectedId, newBounds);
      return;
    }

    // Dragging elements
    if (interaction.selectedIds.size > 0 && state.isDown && state.button === 0 && interaction.tool === 'select') {
      const canvasDx = canvasPos.x - state.startCanvasPos.x;
      const canvasDy = canvasPos.y - state.startCanvasPos.y;

      setInteraction(prev => ({ ...prev, isDragging: true }));

      // Move all selected elements
      for (const [id, startPos] of state.startElementPositions) {
        let newX = startPos.x + canvasDx;
        let newY = startPos.y + canvasDy;
        if (data.grid.snap) {
          const snapped = wb.snapToGrid({ x: newX, y: newY });
          newX = snapped.x;
          newY = snapped.y;
        }
        wb.updateElement(id, { x: newX, y: newY });
      }
      return;
    }

    // Shape creation drag
    if (interaction.isDragging && interaction.dragStart && ['rectangle', 'ellipse', 'triangle', 'hexagon', 'star'].includes(interaction.tool)) {
      const start = interaction.dragStart;
      const tool = interaction.tool;
      const isShift = e.shiftKey;

      // Track shift state so the preview can re-render accordingly
      if (isShift !== pointerState.current.shiftHeld) {
        pointerState.current.shiftHeld = isShift;
        setShiftConstraint(isShift);
      }

      let endX = canvasPos.x;
      let endY = canvasPos.y;

      // Shift + rectangle or ellipse → constrain to square / circle
      if (isShift && (tool === 'rectangle' || tool === 'ellipse')) {
        const rawW = Math.abs(endX - start.x);
        const rawH = Math.abs(endY - start.y);
        const size = Math.min(rawW, rawH);
        endX = start.x + Math.sign(endX - start.x || 1) * size;
        endY = start.y + Math.sign(endY - start.y || 1) * size;
      }

      setInteraction(prev => ({
        ...prev,
        selectionBox: {
          x: Math.min(start.x, endX),
          y: Math.min(start.y, endY),
          width: Math.abs(endX - start.x),
          height: Math.abs(endY - start.y),
        },
      }));
      return;
    }
  }, [screenToCanvas, hitTest, interaction, viewport, data, wb, setInteraction]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const state = pointerState.current;
    if (e.pointerId !== state.pointerId) return;

    state.isDown = false;
    containerRef.current?.releasePointerCapture(e.pointerId);

    const canvasPos = screenToCanvas(e.clientX, e.clientY);

    // End empty-space pan / click-to-deselect
    if (state.startedOnEmpty) {
      if (!state.hasDragged) wb.clearSelection();
      state.startedOnEmpty = false;
      state.isEmptyPanning = false;
      setIsEmptyPanning(false);
      return;
    }

    // End panning
    if (interaction.isPanning) {
      setInteraction(prev => ({ ...prev, isPanning: false, dragStart: null }));
      return;
    }

    // End selection box
    if (interaction.isSelectionBox) {
      setInteraction(prev => ({ ...prev, isSelectionBox: false, selectionBox: null }));
      return;
    }

    // End drawing
    if (interaction.isDrawing && interaction.currentStroke.length > 1) {
      const tool = interaction.tool as 'pen' | 'highlighter' | 'eraser';
      if (tool === 'eraser') {
        // Eraser: find and delete strokes that intersect with the eraser path
        const eraserPath = interaction.currentStroke;
        const toRemove: string[] = [];
        for (const el of data.elements) {
          if (el.type === 'stroke') {
            // Simple proximity check
            for (const ep of eraserPath) {
              for (const sp of (el as WhiteboardStrokeElement).points) {
                const dist = Math.sqrt(
                  Math.pow(ep.x - (sp.x + el.x), 2) + Math.pow(ep.y - (sp.y + el.y), 2)
                );
                if (dist < 10) {
                  toRemove.push(el.id);
                  break;
                }
              }
              if (toRemove.includes(el.id)) break;
            }
          }
        }
        if (toRemove.length > 0) wb.removeElements(toRemove);
      } else {
        const strokeEl = wb.createStroke(interaction.currentStroke, tool);
        wb.addElement(strokeEl);
      }
      setInteraction(prev => ({ ...prev, isDrawing: false, currentStroke: [] }));
      return;
    }
    if (interaction.isDrawing) {
      setInteraction(prev => ({ ...prev, isDrawing: false, currentStroke: [] }));
      return;
    }

    // End connector creation
    if (interaction.connectorStart) {
      const hitElement = hitTest(canvasPos);
      let end: ConnectorEndpoint;
      if (hitElement) {
        end = { type: 'element', elementId: hitElement.id, anchor: 'center' };
      } else {
        // Shift: snap angle to H/V/45° from start
        let endX = canvasPos.x;
        let endY = canvasPos.y;
        if (e.shiftKey && interaction.connectorStart.type === 'point') {
          const sx = interaction.connectorStart.x;
          const sy = interaction.connectorStart.y;
          const dx = endX - sx;
          const dy = endY - sy;
          const angle = Math.atan2(dy, dx);
          const snappedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
          const dist = Math.sqrt(dx * dx + dy * dy);
          endX = sx + dist * Math.cos(snappedAngle);
          endY = sy + dist * Math.sin(snappedAngle);
        }
        end = { type: 'point', x: endX, y: endY };
      }
      const connector = wb.createConnector(interaction.connectorStart, end);
      wb.addElement(connector);
      setInteraction(prev => ({ ...prev, connectorStart: null }));
      return;
    }

    // End shape creation
    if (interaction.isDragging && interaction.dragStart && interaction.selectionBox) {
      const tool = interaction.tool;
      const isShift = e.shiftKey || pointerState.current.shiftHeld;
      const shapeMap: Record<string, WhiteboardShapeElement['shapeType']> = {
        rectangle: 'rectangle',
        ellipse: 'ellipse',
        triangle: isShift ? 'triangle-right' : 'triangle',
        hexagon: isShift ? 'hexagon-pointy' : 'hexagon',
        star: 'star',
      };
      if (tool in shapeMap) {
        const bounds = interaction.selectionBox;
        if (bounds.width > 5 && bounds.height > 5) {
          const shape = wb.createShape(shapeMap[tool], bounds);
          // Rectangle + Shift → rotate 45° (rhombus look)
          if (isShift && tool === 'rectangle') {
            wb.addElement({ ...shape, rotation: 45 });
          } else {
            wb.addElement(shape);
          }
          wb.selectElements([shape.id]);
        }
      }
      pointerState.current.shiftHeld = false;
      setShiftConstraint(false);
      setInteraction(prev => ({
        ...prev,
        isDragging: false,
        dragStart: null,
        selectionBox: null,
      }));
      return;
    }

    // End element drag
    if (interaction.isDragging) {
      setInteraction(prev => ({ ...prev, isDragging: false }));
      return;
    }

    // End resize
    if (interaction.isResizing) {
      setInteraction(prev => ({ ...prev, isResizing: false, resizeHandle: null }));
      state.startElementBounds = null;
      return;
    }
  }, [screenToCanvas, hitTest, interaction, data.elements, wb, setInteraction]);

  // ─── Wheel zoom ───────────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Always zoom to mouse cursor position
    const zoomFactor = Math.pow(0.999, e.deltaY);
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * zoomFactor));
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const newX = mouseX - (mouseX - viewport.x) * (newZoom / viewport.zoom);
    const newY = mouseY - (mouseY - viewport.y) * (newZoom / viewport.zoom);
    wb.setViewport({ x: newX, y: newY, zoom: newZoom });
  }, [viewport, wb]);

  // ─── Double click ─────────────────────────────────────────────────

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    const hitElement = hitTest(canvasPos);

    if (hitElement) {
      if (hitElement.type === 'text') {
        setEditingTextId(hitElement.id);
      } else if (hitElement.type === 'shape') {
        setEditingTextId(hitElement.id); // Edit shape text
      } else {
        onDoubleClick(hitElement.id);
      }
    }
  }, [screenToCanvas, hitTest, onDoubleClick]);

  // ─── Context menu ────────────────────────────────────────────────

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const canvasPos = screenToCanvas(e.clientX, e.clientY);
    const hitElement = hitTest(canvasPos);

    if (hitElement && !interaction.selectedIds.has(hitElement.id)) {
      wb.selectElements([hitElement.id]);
    }

    onContextMenu(e, hitElement?.id);
  }, [screenToCanvas, hitTest, interaction.selectedIds, wb, onContextMenu]);

  // ─── Keyboard shortcuts ──────────────────────────────────────────

  // Helper: recompute shape-creation selectionBox from last known canvas pos + shift state
  const recomputeShapePreview = useCallback((isShift: boolean) => {
    const state = pointerState.current;
    if (!state.isDown || !state.hasDragged) return;
    const tool = interaction.tool;
    if (!['rectangle', 'ellipse', 'triangle', 'hexagon', 'star'].includes(tool)) return;
    const start = interaction.dragStart;
    if (!start) return;

    state.shiftHeld = isShift;
    setShiftConstraint(isShift);

    let endX = state.lastCanvasPos.x;
    let endY = state.lastCanvasPos.y;

    if (isShift && (tool === 'rectangle' || tool === 'ellipse')) {
      const rawW = Math.abs(endX - start.x);
      const rawH = Math.abs(endY - start.y);
      const size = Math.min(rawW, rawH);
      endX = start.x + Math.sign(endX - start.x || 1) * size;
      endY = start.y + Math.sign(endY - start.y || 1) * size;
    }

    setInteraction(prev => ({
      ...prev,
      selectionBox: {
        x: Math.min(start.x, endX),
        y: Math.min(start.y, endY),
        width: Math.abs(endX - start.x),
        height: Math.abs(endY - start.y),
      },
    }));
  }, [interaction.tool, interaction.dragStart, setInteraction]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if editing text
      if (editingTextId) {
        if (e.key === 'Escape') setEditingTextId(null);
        return;
      }

      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          if (interaction.selectedIds.size > 0) {
            e.preventDefault();
            wb.removeElements([...interaction.selectedIds]);
          }
          break;
        case 'Escape':
          wb.clearSelection();
          wb.setTool('select');
          break;
        case 'z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (e.shiftKey) wb.redo(); else wb.undo();
          }
          break;
        case 'y':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.redo();
          }
          break;
        case 'a':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.selectElements(data.elements.map(el => el.id));
          }
          break;
        case 'd':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.duplicateElements([...interaction.selectedIds]);
          }
          break;
        // Tool shortcuts
        case 'v': case 'V': if (!e.ctrlKey) wb.setTool('select'); break;
        case 'r': case 'R': if (!e.ctrlKey) wb.setTool('rectangle'); break;
        case 'o': case 'O': wb.setTool('ellipse'); break;
        case 'p': case 'P': wb.setTool('pen'); break;
        case 't': case 'T': wb.setTool('text'); break;
        case 'l': case 'L': wb.setTool('connector'); break;
        case 'e': case 'E': wb.setTool('eraser'); break;
        case 'g': case 'G':
          if (!e.ctrlKey) wb.toggleGrid();
          break;
        case ']':
          if (interaction.selectedIds.size > 0) wb.bringToFront([...interaction.selectedIds]);
          break;
        case '[':
          if (interaction.selectedIds.size > 0) wb.sendToBack([...interaction.selectedIds]);
          break;
        case '+': case '=':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.setViewport({ ...viewport, zoom: Math.min(MAX_ZOOM, viewport.zoom + ZOOM_STEP) });
          }
          break;
        case '-':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.setViewport({ ...viewport, zoom: Math.max(MIN_ZOOM, viewport.zoom - ZOOM_STEP) });
          }
          break;
        case '0':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.setViewport({ x: 0, y: 0, zoom: 1 });
          }
          break;
        case '1':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            wb.zoomToFit();
          }
          break;
        case 'Shift':
          recomputeShapePreview(true);
          break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') recomputeShapePreview(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [editingTextId, interaction, data.elements, viewport, wb, recomputeShapePreview]);

  // ─── Sorted elements ─────────────────────────────────────────────

  const sortedElements = useMemo(() =>
    [...data.elements].sort((a, b) => a.zIndex - b.zIndex),
    [data.elements]
  );

  // ─── Grid background style ───────────────────────────────────────

  const gridStyle = useMemo(() => {
    if (!data.grid.visible) return {};
    const gridSize = data.grid.size * viewport.zoom;
    return {
      backgroundSize: `${gridSize}px ${gridSize}px`,
      '--grid-offset-x': `${viewport.x % gridSize}px`,
      '--grid-offset-y': `${viewport.y % gridSize}px`,
    } as React.CSSProperties;
  }, [data.grid, viewport]);

  // ─── Cursor ───────────────────────────────────────────────────────

  const cursorClass = useMemo(() => {
    if (interaction.isPanning || isEmptyPanning) return 'whiteboard-view--panning-active';
    if (['pen', 'highlighter', 'eraser', 'rectangle', 'ellipse', 'triangle', 'hexagon', 'star'].includes(interaction.tool)) return 'whiteboard-view--drawing';
    return '';
  }, [interaction.tool, interaction.isPanning, isEmptyPanning]);

  // ─── Selection bounding card ──────────────────────────────────────
  // Computes the union bounding box (canvas coords) of all selected elements.

  const selectionCardBounds = useMemo(() => {
    if (interaction.selectedIds.size === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let found = false;
    for (const el of data.elements) {
      if (!interaction.selectedIds.has(el.id)) continue;
      found = true;
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width);
      maxY = Math.max(maxY, el.y + el.height);
    }
    if (!found) return null;
    // Padding in canvas units (stays visually proportional)
    const pad = 10 / viewport.zoom;
    return {
      left: (minX - pad) * viewport.zoom + viewport.x,
      top: (minY - pad) * viewport.zoom + viewport.y,
      width: (maxX - minX + 2 * pad) * viewport.zoom,
      height: (maxY - minY + 2 * pad) * viewport.zoom,
    };
  }, [data.elements, interaction.selectedIds, viewport]);

  // ─── Render element ───────────────────────────────────────────────

  const renderElement = useCallback((el: WhiteboardElement) => {
    const isSelected = interaction.selectedIds.has(el.id);
    const isHovered = interaction.hoveredId === el.id;

    const style: React.CSSProperties = {
      left: el.x * viewport.zoom + viewport.x,
      top: el.y * viewport.zoom + viewport.y,
      width: el.width * viewport.zoom,
      height: el.height * viewport.zoom,
      transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
      opacity: el.opacity,
      zIndex: el.zIndex,
    };

    const className = [
      'whiteboard-element',
      isSelected && 'whiteboard-element--selected',
      isHovered && 'whiteboard-element--hovered',
      el.locked && 'whiteboard-element--locked',
      interaction.isDragging && isSelected && 'whiteboard-element--dragging',
    ].filter(Boolean).join(' ');

    return (
      <div
        key={el.id}
        className={className}
        style={style}
        data-element-id={el.id}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (el.type === 'text' || el.type === 'shape') {
            setEditingTextId(el.id);
          } else {
            onDoubleClick(el.id);
          }
        }}
      >
        {/* Element content */}
        {el.type === 'card' && (
          <WhiteboardCardRenderer element={el as WhiteboardCardElement} zoom={viewport.zoom} />
        )}
        {el.type === 'shape' && (
          <WhiteboardShapeRenderer
            element={el as WhiteboardShapeElement}
            isEditing={editingTextId === el.id}
            onTextChange={(text: string) => {
              wb.updateElement(el.id, { text } as Partial<WhiteboardShapeElement>);
            }}
            onBlur={() => setEditingTextId(null)}
          />
        )}
        {el.type === 'text' && (
          <div
            className={`whiteboard-text ${editingTextId === el.id ? 'whiteboard-text--editing' : ''}`}
            style={{
              color: (el as WhiteboardTextElement).color,
              fontSize: (el as WhiteboardTextElement).fontSize * viewport.zoom,
              fontWeight: (el as WhiteboardTextElement).fontWeight,
              fontStyle: (el as WhiteboardTextElement).fontStyle,
              textAlign: (el as WhiteboardTextElement).textAlign,
            }}
          >
            {editingTextId === el.id ? (
              <textarea
                autoFocus
                value={(el as WhiteboardTextElement).text}
                onChange={(e) => wb.updateElement(el.id, { text: e.target.value } as Partial<WhiteboardTextElement>)}
                onBlur={() => setEditingTextId(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingTextId(null);
                  e.stopPropagation();
                }}
              />
            ) : (
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {(el as WhiteboardTextElement).text || 'Double-click to edit'}
              </span>
            )}
          </div>
        )}
        {el.type === 'image' && (
          <div className="whiteboard-image" style={{ borderRadius: (el as WhiteboardImageElement).borderRadius }}>
            <img
              src={(el as WhiteboardImageElement).src}
              style={{ objectFit: (el as WhiteboardImageElement).objectFit }}
              alt=""
              draggable={false}
            />
          </div>
        )}

        {/* Resize handles for selected elements */}
        {isSelected && !el.locked && (
          <div className="whiteboard-element__resize-handles">
            {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(handle => (
              <div key={handle} className={`whiteboard-element__resize-handle whiteboard-element__resize-handle--${handle}`} />
            ))}
          </div>
        )}

        {/* Connector anchor points */}
        {(isHovered || isSelected) && interaction.tool === 'connector' && (
          <div className="whiteboard-element__anchor-points">
            {['top', 'right', 'bottom', 'left'].map(anchor => (
              <div key={anchor} className={`whiteboard-element__anchor whiteboard-element__anchor--${anchor}`} />
            ))}
          </div>
        )}
      </div>
    );
  }, [interaction, viewport, editingTextId, wb, onDoubleClick]);

  // ─── Render strokes SVG ───────────────────────────────────────────

  const renderStrokes = useMemo(() => {
    const strokeElements = data.elements.filter(el => el.type === 'stroke') as WhiteboardStrokeElement[];
    return (
      <svg className="whiteboard-view__strokes-svg">
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
          {strokeElements.map(stroke => (
            <WhiteboardStrokeRenderer
              key={stroke.id}
              element={stroke}
              isSelected={interaction.selectedIds.has(stroke.id)}
            />
          ))}
          {/* Current stroke being drawn */}
          {interaction.isDrawing && interaction.currentStroke.length > 1 && (
            <WhiteboardStrokeRenderer
              element={{
                id: '__current_stroke__',
                type: 'stroke',
                x: 0,
                y: 0,
                width: 0,
                height: 0,
                rotation: 0,
                locked: false,
                opacity: interaction.tool === 'highlighter' ? 0.4 : 1,
                zIndex: 9999,
                points: interaction.currentStroke,
                color: interaction.tool === 'highlighter' ? wb.settings.highlighter.color : 
                       interaction.tool === 'eraser' ? 'var(--color-error)' : wb.settings.pen.color,
                strokeWidth: interaction.tool === 'highlighter' ? wb.settings.highlighter.strokeWidth :
                             interaction.tool === 'eraser' ? wb.settings.eraser.strokeWidth : wb.settings.pen.strokeWidth,
                tool: interaction.tool as 'pen' | 'highlighter' | 'eraser',
              }}
              isAbsolute
            />
          )}
        </g>
      </svg>
    );
  }, [data.elements, viewport, interaction, wb.settings]);

  // ─── Render connectors SVG ────────────────────────────────────────

  const renderConnectors = useMemo(() => {
    const connectors = data.elements.filter(el => el.type === 'connector') as WhiteboardConnectorElement[];

    const getEndpointPos = (endpoint: ConnectorEndpoint): Point => {
      if (endpoint.type === 'point') return { x: endpoint.x, y: endpoint.y };
      const el = data.elements.find(e => e.id === endpoint.elementId);
      if (!el) return { x: 0, y: 0 };
      switch (endpoint.anchor) {
        case 'top': return { x: el.x + el.width / 2, y: el.y };
        case 'right': return { x: el.x + el.width, y: el.y + el.height / 2 };
        case 'bottom': return { x: el.x + el.width / 2, y: el.y + el.height };
        case 'left': return { x: el.x, y: el.y + el.height / 2 };
        default: return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
      }
    };

    return (
      <svg className="whiteboard-view__strokes-svg" style={{ zIndex: 3 }}>
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--text-primary)" />
          </marker>
          <marker id="arrowhead-start" markerWidth="10" markerHeight="7" refX="0" refY="3.5" orient="auto-start-reverse">
            <polygon points="0 0, 10 3.5, 0 7" fill="var(--text-primary)" />
          </marker>
        </defs>
        <g transform={`translate(${viewport.x}, ${viewport.y}) scale(${viewport.zoom})`}>
          {connectors.map(conn => {
            const start = getEndpointPos(conn.start);
            const end = getEndpointPos(conn.end);
            const isSelected = interaction.selectedIds.has(conn.id);

            let pathD: string;
            if (conn.pathType === 'curved') {
              const dx = end.x - start.x;
              const cx1 = start.x + dx * 0.25;
              const cy1 = start.y;
              const cx2 = end.x - dx * 0.25;
              const cy2 = end.y;
              pathD = `M ${start.x} ${start.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${end.x} ${end.y}`;
            } else if (conn.pathType === 'elbow') {
              const mx = (start.x + end.x) / 2;
              pathD = `M ${start.x} ${start.y} L ${mx} ${start.y} L ${mx} ${end.y} L ${end.x} ${end.y}`;
            } else {
              pathD = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
            }

            const dashArray = conn.strokeStyle === 'dashed' ? '8 4' :
                              conn.strokeStyle === 'dotted' ? '2 4' : undefined;

            return (
              <g key={conn.id}>
                {/* Hit target (wider invisible stroke) */}
                <path
                  d={pathD}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(conn.strokeWidth + 10, 15)}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={() => wb.selectElements([conn.id])}
                />
                <path
                  d={pathD}
                  fill="none"
                  stroke={isSelected ? 'var(--accent-primary)' : conn.stroke}
                  strokeWidth={conn.strokeWidth}
                  strokeDasharray={dashArray}
                  markerEnd={conn.endArrowhead !== 'none' ? 'url(#arrowhead)' : undefined}
                  markerStart={conn.startArrowhead !== 'none' ? 'url(#arrowhead-start)' : undefined}
                />
                {conn.label && (
                  <text
                    x={(start.x + end.x) / 2}
                    y={(start.y + end.y) / 2 - 8}
                    textAnchor="middle"
                    fill="var(--text-secondary)"
                    fontSize="12"
                    style={{ pointerEvents: 'none' }}
                  >
                    {conn.label}
                  </text>
                )}
              </g>
            );
          })}
          {/* Connector being created */}
          {interaction.connectorStart && (
            <line
              x1={interaction.connectorStart.type === 'point' ? interaction.connectorStart.x : 0}
              y1={interaction.connectorStart.type === 'point' ? interaction.connectorStart.y : 0}
              x2={pointerState.current.isDown ? screenToCanvas(pointerState.current.startScreenPos.x, pointerState.current.startScreenPos.y).x : 0}
              y2={pointerState.current.isDown ? screenToCanvas(pointerState.current.startScreenPos.x, pointerState.current.startScreenPos.y).y : 0}
              stroke="var(--accent-primary)"
              strokeWidth="2"
              strokeDasharray="5 3"
            />
          )}
        </g>
      </svg>
    );
  }, [data.elements, viewport, interaction, wb, screenToCanvas]);

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className={`whiteboard-view__canvas ${cursorClass}`}
      style={gridStyle}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      tabIndex={0}
    >
      {/* Strokes SVG layer */}
      {renderStrokes}

      {/* Connectors SVG layer */}
      {renderConnectors}

      {/* Elements layer (DOM elements) */}
      <div className="whiteboard-view__elements">
        {sortedElements
          .filter(el => el.type !== 'stroke' && el.type !== 'connector')
          .map(renderElement)}
      </div>

      {/* Selection bounds card — encompasses all selected items (including strokes) */}
      {selectionCardBounds && !interaction.isSelectionBox && (
        <div
          className="whiteboard-view__selection-card"
          style={{
            left: selectionCardBounds.left,
            top: selectionCardBounds.top,
            width: selectionCardBounds.width,
            height: selectionCardBounds.height,
          }}
        />
      )}

      {/* Selection box */}
      {interaction.selectionBox && interaction.isSelectionBox && (
        <div
          className="whiteboard-view__selection-box"
          style={{
            left: interaction.selectionBox.x * viewport.zoom + viewport.x,
            top: interaction.selectionBox.y * viewport.zoom + viewport.y,
            width: interaction.selectionBox.width * viewport.zoom,
            height: interaction.selectionBox.height * viewport.zoom,
          }}
        />
      )}

      {/* Shape creation preview — live fainted shape */}
      {interaction.selectionBox && interaction.isDragging && !interaction.isSelectionBox && (() => {
        const isShift = shiftConstraint;
        const shapeMap: Record<string, string> = {
          rectangle: 'rectangle',
          ellipse: 'ellipse',
          triangle: isShift ? 'triangle-right' : 'triangle',
          hexagon: isShift ? 'hexagon-pointy' : 'hexagon',
          star: 'star',
        };
        const shapeType = shapeMap[interaction.tool];
        if (!shapeType) return null;
        const box = interaction.selectionBox;
        const sw = box.width * viewport.zoom;
        const sh = box.height * viewport.zoom;
        const sl = box.x * viewport.zoom + viewport.x;
        const st = box.y * viewport.zoom + viewport.y;
        const { fill, stroke, strokeWidth, strokeStyle, borderRadius } = wb.settings.shape;
        const dashArray = strokeStyle === 'dashed' ? '8 4' : strokeStyle === 'dotted' ? '2 4' : undefined;
        // Rectangle + Shift → rotate 45° in preview
        const previewRotation = isShift && interaction.tool === 'rectangle' ? 45 : 0;
        return (
          <div
            style={{
              position: 'absolute',
              left: sl,
              top: st,
              width: sw,
              height: sh,
              opacity: 0.45,
              pointerEvents: 'none',
              zIndex: 'var(--wb-z-overlay)' as any,
              transform: previewRotation ? `rotate(${previewRotation}deg)` : undefined,
            }}
          >
            <svg
              viewBox={`0 0 ${sw} ${sh}`}
              width={sw}
              height={sh}
              style={{ display: 'block', overflow: 'visible' }}
            >
              {shapeType === 'rectangle' ? (
                <rect
                  x={strokeWidth / 2}
                  y={strokeWidth / 2}
                  width={Math.max(0, sw - strokeWidth)}
                  height={Math.max(0, sh - strokeWidth)}
                  rx={borderRadius}
                  ry={borderRadius}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeDasharray={dashArray}
                />
              ) : shapeType === 'ellipse' ? (
                <ellipse
                  cx={sw / 2}
                  cy={sh / 2}
                  rx={Math.max(0, (sw - strokeWidth) / 2)}
                  ry={Math.max(0, (sh - strokeWidth) / 2)}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeDasharray={dashArray}
                />
              ) : (
                <path
                  d={getShapePath(shapeType as any, sw, sh)}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeDasharray={dashArray}
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </div>
        );
      })()}
    </div>
  );
};
