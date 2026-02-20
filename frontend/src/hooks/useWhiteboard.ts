import { useCallback, useRef, useState, useEffect } from 'react';
import { useNode, useUpdateNode } from '@/hooks/useNodes';
import type { Node } from '@/types/api';
import type { ASTWhiteboard } from '@/types/ast';
import { parseAST } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import type {
  WhiteboardData,
  WhiteboardElement,
  WhiteboardHistoryEntry,
  WhiteboardSettings,
  WhiteboardInteractionState,
  WhiteboardTool,
  Point,
  Bounds,
  StrokePoint,
  WhiteboardCardElement,
  WhiteboardShapeElement,
  WhiteboardStrokeElement,
  WhiteboardTextElement,
  WhiteboardConnectorElement,
  ConnectorEndpoint,
} from '@/types/whiteboard';
import {
  DEFAULT_WHITEBOARD_DATA,
  DEFAULT_WHITEBOARD_SETTINGS,
  createElementId,
  getStrokeBounds,
} from '@/types/whiteboard';

const MAX_HISTORY = 50;
const SAVE_DEBOUNCE_MS = 1000;

// ─── Parse whiteboard data from node name AST ──────────────────────

function parseWhiteboardData(node: Node | undefined): WhiteboardData {
  if (!node?.name) return { ...DEFAULT_WHITEBOARD_DATA };

  const ast = parseAST(node.name);
  const wb = ast.find(b => b.type === 'whiteboard') as ASTWhiteboard | undefined;
  if (wb) {
    return wb.data;
  }

  return { ...DEFAULT_WHITEBOARD_DATA };
}

/**
 * Extract the title from a whiteboard node's AST.
 *
 * The title is the first paragraph/heading block (children approach).
 */
function parseWhiteboardTitle(node: Node | undefined): string {
  if (!node?.name) return '';
  const ast = parseAST(node.name);
  const para = ast.find(b => b.type === 'paragraph' || b.type === 'heading');
  if (para) {
    return stringifyAST([para], { mode: StringifyMode.TEXT_ONLY });
  }
  return '';
}

// ─── Main hook ─────────────────────────────────────────────────────

export function useWhiteboard(nodeId: number | null) {
  const { data: node } = useNode(nodeId, {
    include_children: true,
  });
  const updateNode = useUpdateNode();
  // Stable ref to updateNode.mutate avoids recreating saveToBackend on every mutation state change
  const mutateRef = useRef(updateNode.mutate);
  mutateRef.current = updateNode.mutate;

  // Whiteboard data state
  const [data, setData] = useState<WhiteboardData>(DEFAULT_WHITEBOARD_DATA);
  /** Cached title — updated when the node changes, preserved across data saves. */
  const titleRef = useRef<string>('');
  /** Latest data snapshot for flush-on-unmount. */
  const latestDataRef = useRef<WhiteboardData>(DEFAULT_WHITEBOARD_DATA);
  const [settings, setSettings] = useState<WhiteboardSettings>(DEFAULT_WHITEBOARD_SETTINGS);
  const [interaction, setInteraction] = useState<WhiteboardInteractionState>({
    tool: 'select',
    selectedIds: new Set(),
    hoveredId: null,
    isDragging: false,
    isResizing: false,
    isRotating: false,
    isPanning: false,
    isDrawing: false,
    isSelectionBox: false,
    selectionBox: null,
    dragStart: null,
    resizeHandle: null,
    currentStroke: [],
    connectorStart: null,
  });

  // History for undo/redo
  const historyRef = useRef<WhiteboardHistoryEntry[]>([]);
  const historyIndexRef = useRef(-1);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Load data from node
  useEffect(() => {
    if (node) {
      const parsed = parseWhiteboardData(node);
      titleRef.current = parseWhiteboardTitle(node);
      setData(parsed);
      // Initialize history
      historyRef.current = [{ elements: parsed.elements, timestamp: Date.now() }];
      historyIndexRef.current = 0;
    }
  }, [node?.id]); // Only reload when node ID changes

  // ─── Save to backend (debounced) ──────────────────────────────────

  /** Serialize and fire the mutation immediately (no debounce). */
  const flushSave = useCallback((whiteboardData: WhiteboardData) => {
    if (!nodeId) return;
    const ast = [
      { type: 'paragraph' as const, children: [{ type: 'text' as const, text: titleRef.current }] },
      { type: 'whiteboard' as const, data: whiteboardData },
    ];
    const serialized = JSON.stringify(ast);
    mutateRef.current({ id: nodeId, data: { name: serialized } });
  }, [nodeId]);

  const saveToBackend = useCallback((newData: WhiteboardData) => {
    latestDataRef.current = newData;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      flushSave(newData);
      saveTimeoutRef.current = undefined;
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // ─── History management ───────────────────────────────────────────

  const pushHistory = useCallback((elements: WhiteboardElement[]) => {
    const history = historyRef.current;
    const idx = historyIndexRef.current;

    // Trim future history
    history.splice(idx + 1);

    // Add new entry
    history.push({ elements: structuredClone(elements), timestamp: Date.now() });

    // Limit history size
    if (history.length > MAX_HISTORY) {
      history.shift();
    }

    historyIndexRef.current = history.length - 1;
  }, []);

  const undo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx > 0) {
      historyIndexRef.current = idx - 1;
      const entry = historyRef.current[idx - 1];
      setData(prev => {
        const newData = { ...prev, elements: structuredClone(entry.elements) };
        saveToBackend(newData);
        return newData;
      });
    }
  }, [saveToBackend]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    const idx = historyIndexRef.current;
    if (idx < history.length - 1) {
      historyIndexRef.current = idx + 1;
      const entry = history[idx + 1];
      setData(prev => {
        const newData = { ...prev, elements: structuredClone(entry.elements) };
        saveToBackend(newData);
        return newData;
      });
    }
  }, [saveToBackend]);

  // ─── Element manipulation ─────────────────────────────────────────

  const updateElements = useCallback((updater: (elements: WhiteboardElement[]) => WhiteboardElement[]) => {
    setData(prev => {
      const newElements = updater(prev.elements);
      const newData = { ...prev, elements: newElements };
      pushHistory(newElements);
      saveToBackend(newData);
      return newData;
    });
  }, [pushHistory, saveToBackend]);

  const addElement = useCallback((element: WhiteboardElement) => {
    updateElements(elements => [...elements, element]);
  }, [updateElements]);

  const removeElements = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    updateElements(elements => elements.filter(el => !idSet.has(el.id)));
    setInteraction(prev => ({
      ...prev,
      selectedIds: new Set([...prev.selectedIds].filter(id => !idSet.has(id))),
    }));
  }, [updateElements]);

  const updateElement = useCallback((id: string, updates: Partial<WhiteboardElement>) => {
    updateElements(elements =>
      elements.map(el => (el.id === id ? { ...el, ...updates } as WhiteboardElement : el))
    );
  }, [updateElements]);

  const moveElements = useCallback((ids: string[], dx: number, dy: number) => {
    updateElements(elements =>
      elements.map(el =>
        ids.includes(el.id)
          ? { ...el, x: el.x + dx, y: el.y + dy } as WhiteboardElement
          : el
      )
    );
  }, [updateElements]);

  const resizeElement = useCallback((id: string, bounds: Bounds) => {
    updateElement(id, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }, [updateElement]);

  const duplicateElements = useCallback((ids: string[]) => {
    updateElements(elements => {
      const copies: WhiteboardElement[] = [];
      for (const el of elements) {
        if (ids.includes(el.id)) {
          copies.push({
            ...structuredClone(el),
            id: createElementId(),
            x: el.x + 20,
            y: el.y + 20,
          } as WhiteboardElement);
        }
      }
      return [...elements, ...copies];
    });
  }, [updateElements]);

  const bringToFront = useCallback((ids: string[]) => {
    updateElements(elements => {
      const maxZ = Math.max(...elements.map(el => el.zIndex), 0);
      let z = maxZ + 1;
      return elements.map(el =>
        ids.includes(el.id) ? { ...el, zIndex: z++ } as WhiteboardElement : el
      );
    });
  }, [updateElements]);

  const sendToBack = useCallback((ids: string[]) => {
    updateElements(elements => {
      const minZ = Math.min(...elements.map(el => el.zIndex), 0);
      let z = minZ - ids.length;
      return elements.map(el =>
        ids.includes(el.id) ? { ...el, zIndex: z++ } as WhiteboardElement : el
      );
    });
  }, [updateElements]);

  // ─── Tool state ───────────────────────────────────────────────────

  const setTool = useCallback((tool: WhiteboardTool) => {
    setInteraction(prev => ({
      ...prev,
      tool,
      selectedIds: tool !== 'select' ? new Set() : prev.selectedIds,
      isDragging: false,
      isResizing: false,
      isDrawing: false,
      isSelectionBox: false,
      selectionBox: null,
      currentStroke: [],
      connectorStart: null,
    }));
  }, []);

  const selectElements = useCallback((ids: string[], append = false) => {
    setInteraction(prev => {
      const newSelection = append
        ? new Set([...prev.selectedIds, ...ids])
        : new Set(ids);
      return { ...prev, selectedIds: newSelection };
    });
  }, []);

  const clearSelection = useCallback(() => {
    setInteraction(prev => ({ ...prev, selectedIds: new Set() }));
  }, []);

  // ─── Viewport ─────────────────────────────────────────────────────

  const setViewport = useCallback((viewport: { x: number; y: number; zoom: number }) => {
    setData(prev => ({ ...prev, viewport }));
  }, []);

  const zoomToFit = useCallback(() => {
    // We need the canvas dimensions from the canvas container
    // This will be called with the canvas dimensions
    if (data.elements.length === 0) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of data.elements) {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + el.width);
      maxY = Math.max(maxY, el.y + el.height);
    }

    const padding = 80;
    const contentWidth = maxX - minX + padding * 2;
    const contentHeight = maxY - minY + padding * 2;

    // Assume a default canvas size if we don't have it
    const canvasWidth = window.innerWidth - 300;
    const canvasHeight = window.innerHeight - 100;

    const zoom = Math.min(
      canvasWidth / contentWidth,
      canvasHeight / contentHeight,
      2 // Max zoom
    );

    setViewport({
      x: -(minX - padding) * zoom + (canvasWidth - contentWidth * zoom) / 2,
      y: -(minY - padding) * zoom + (canvasHeight - contentHeight * zoom) / 2,
      zoom: Math.max(0.1, zoom),
    });
  }, [data.elements, setViewport]);

  // ─── Element creation helpers ─────────────────────────────────────

  const createCard = useCallback((nodeId: number, nodeUuid: string, position: Point): WhiteboardCardElement => {
    const maxZ = Math.max(...data.elements.map(el => el.zIndex), 0);
    return {
      id: createElementId(),
      type: 'card',
      x: position.x,
      y: position.y,
      width: 280,
      height: 180,
      rotation: 0,
      locked: false,
      opacity: 1,
      zIndex: maxZ + 1,
      nodeId,
      nodeUuid,
      collapsed: false,
      color: null,
      showChildren: true,
      cardMode: 'block',
    };
  }, [data.elements]);

  const createReferenceCard = useCallback((nodeId: number, nodeUuid: string, position: Point): WhiteboardCardElement => {
    const maxZ = Math.max(...data.elements.map(el => el.zIndex), 0);
    return {
      id: createElementId(),
      type: 'card',
      x: position.x,
      y: position.y,
      width: 400,
      height: 320,
      rotation: 0,
      locked: false,
      opacity: 1,
      zIndex: maxZ + 1,
      nodeId,
      nodeUuid,
      collapsed: false,
      color: null,
      showChildren: true,
      cardMode: 'reference',
    };
  }, [data.elements]);

  const createShape = useCallback((shapeType: WhiteboardShapeElement['shapeType'], bounds: Bounds): WhiteboardShapeElement => {
    const maxZ = Math.max(...data.elements.map(el => el.zIndex), 0);
    return {
      id: createElementId(),
      type: 'shape',
      x: bounds.x,
      y: bounds.y,
      width: Math.max(bounds.width, 40),
      height: Math.max(bounds.height, 40),
      rotation: 0,
      locked: false,
      opacity: 1,
      zIndex: maxZ + 1,
      shapeType,
      fill: settings.shape.fill,
      stroke: settings.shape.stroke,
      strokeWidth: settings.shape.strokeWidth,
      strokeStyle: settings.shape.strokeStyle,
      borderRadius: settings.shape.borderRadius,
      text: '',
      textColor: 'var(--text-primary)',
      fontSize: 14,
      textAlign: 'center',
      fontWeight: 'normal',
    };
  }, [data.elements, settings.shape]);

  const createStroke = useCallback((points: StrokePoint[], tool: 'pen' | 'highlighter' | 'eraser'): WhiteboardStrokeElement => {
    const maxZ = Math.max(...data.elements.map(el => el.zIndex), 0);
    const bounds = getStrokeBounds(points);
    const penSettings = tool === 'highlighter' ? settings.highlighter : settings.pen;
    return {
      id: createElementId(),
      type: 'stroke',
      x: bounds.x,
      y: bounds.y,
      width: Math.max(bounds.width, 1),
      height: Math.max(bounds.height, 1),
      rotation: 0,
      locked: false,
      opacity: penSettings.opacity,
      zIndex: maxZ + 1,
      points: points.map(p => ({ ...p, x: p.x - bounds.x, y: p.y - bounds.y })),
      color: penSettings.color,
      strokeWidth: penSettings.strokeWidth,
      tool,
    };
  }, [data.elements, settings.pen, settings.highlighter]);

  const createText = useCallback((position: Point): WhiteboardTextElement => {
    const maxZ = Math.max(...data.elements.map(el => el.zIndex), 0);
    return {
      id: createElementId(),
      type: 'text',
      x: position.x,
      y: position.y,
      width: 200,
      height: 40,
      rotation: 0,
      locked: false,
      opacity: 1,
      zIndex: maxZ + 1,
      text: '',
      color: settings.text.color,
      fontSize: settings.text.fontSize,
      fontWeight: settings.text.fontWeight,
      fontStyle: settings.text.fontStyle,
      textAlign: settings.text.textAlign,
      fontFamily: 'inherit',
    };
  }, [data.elements, settings.text]);

  const createConnector = useCallback((start: ConnectorEndpoint, end: ConnectorEndpoint): WhiteboardConnectorElement => {
    const maxZ = Math.max(...data.elements.map(el => el.zIndex), 0);
    const startPoint = start.type === 'point' ? start : { x: 0, y: 0 };
    const endPoint = end.type === 'point' ? end : { x: 100, y: 100 };
    return {
      id: createElementId(),
      type: 'connector',
      x: Math.min(startPoint.x, endPoint.x),
      y: Math.min(startPoint.y, endPoint.y),
      width: Math.abs(endPoint.x - startPoint.x) || 100,
      height: Math.abs(endPoint.y - startPoint.y) || 100,
      rotation: 0,
      locked: false,
      opacity: 1,
      zIndex: maxZ + 1,
      start,
      end,
      pathType: settings.connector.pathType,
      stroke: settings.connector.stroke,
      strokeWidth: settings.connector.strokeWidth,
      strokeStyle: settings.connector.strokeStyle,
      startArrowhead: settings.connector.startArrowhead,
      endArrowhead: settings.connector.endArrowhead,
      label: '',
      labelPosition: 0.5,
      controlPoints: [],
    };
  }, [data.elements, settings.connector]);

  // ─── Grid ─────────────────────────────────────────────────────────

  const toggleGrid = useCallback(() => {
    setData(prev => ({
      ...prev,
      grid: { ...prev.grid, visible: !prev.grid.visible },
    }));
  }, []);

  const toggleSnap = useCallback(() => {
    setData(prev => ({
      ...prev,
      grid: { ...prev.grid, snap: !prev.grid.snap },
    }));
  }, []);

  const snapToGrid = useCallback((point: Point): Point => {
    if (!data.grid.snap) return point;
    const size = data.grid.size;
    return {
      x: Math.round(point.x / size) * size,
      y: Math.round(point.y / size) * size,
    };
  }, [data.grid]);

  // ─── Flush pending save on unmount (don't lose strokes) ───────────

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        // Fire the save immediately with the latest data
        flushSave(latestDataRef.current);
      }
    };
  }, [flushSave]);

  return {
    // Data
    node,
    data,
    settings,
    interaction,
    // Element operations
    addElement,
    removeElements,
    updateElement,
    moveElements,
    resizeElement,
    duplicateElements,
    bringToFront,
    sendToBack,
    // Element creation
    createCard,
    createReferenceCard,
    createShape,
    createStroke,
    createText,
    createConnector,
    // Tool state
    setTool,
    selectElements,
    clearSelection,
    setInteraction,
    // Viewport
    setViewport,
    zoomToFit,
    // Grid
    toggleGrid,
    toggleSnap,
    snapToGrid,
    // History
    undo,
    redo,
    // Settings
    setSettings,
    // Save
    saveToBackend,
  };
}

export type UseWhiteboardReturn = ReturnType<typeof useWhiteboard>;
