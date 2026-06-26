import { useCallback, useRef, useState, useEffect } from 'react';
import { useNode, useUpdateNode } from '@/features/content';

import type {
  WhiteboardData,
  WhiteboardElement,
  WhiteboardGroup,
  WhiteboardSettings,
  WhiteboardInteractionState,
  WhiteboardTool,
  Bounds,
  WhiteboardStrokeElement,
} from '@/features/whiteboard/types/whiteboard';
import { DEFAULT_WHITEBOARD_DATA, DEFAULT_WHITEBOARD_SETTINGS } from '@/features/whiteboard/types/whiteboard';
import { useGridSettings, useGridToggles } from './useWhiteboardSelectors';
import { parseWhiteboardData, parseWhiteboardTitle } from './useWhiteboard.utils';
import { useWhiteboardSave } from './useWhiteboard.save';
import { useWhiteboardHistory } from './useWhiteboard.history';
import { useWhiteboardCreators } from './useWhiteboard.creators';
import { useWhiteboardAlign } from './useWhiteboard.align';
import { useWhiteboardGroups } from './useWhiteboard.groups';

export function useWhiteboard(nodeUuid: string | null) {
  const { data: node } = useNode(nodeUuid, { include_children: true });
  const updateNode = useUpdateNode();
  const mutateRef = useRef(updateNode.mutate);
  mutateRef.current = updateNode.mutate;

  const [data, setData] = useState<WhiteboardData>(DEFAULT_WHITEBOARD_DATA);
  const titleRef = useRef<string>('');
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
    eraserMarkedIds: new Set(),
    connectorStart: null,
  });

  // Sub-hooks
  const { flushSave, saveToBackend, saveTimeoutRef, latestDataRef } = useWhiteboardSave(nodeUuid, titleRef, mutateRef);
  const { historyRef, historyIndexRef, pushHistory, undo, redo } = useWhiteboardHistory(setData, saveToBackend);
  const creators = useWhiteboardCreators(data, settings);
  const { alignElements, distributeElements } = useWhiteboardAlign(
    useCallback((updater: (elements: WhiteboardElement[]) => WhiteboardElement[]) => {
      setData(prev => {
        const newElements = updater(prev.elements);
        const newData = { ...prev, elements: newElements };
        pushHistory(newElements, prev.groups);
        saveToBackend(newData);
        return newData;
      });
    }, [pushHistory, saveToBackend])
  );

  // Load data from node
  useEffect(() => {
    if (node) {
      const parsed = parseWhiteboardData(node);
      titleRef.current = parseWhiteboardTitle(node);
      setData(parsed);
      historyRef.current = [{ elements: parsed.elements, groups: parsed.groups, timestamp: Date.now() }];
      historyIndexRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only reset when the node identity changes; refs and full node object are intentionally excluded.
  }, [node?.uuid]);

  // Element manipulation
  const updateElements = useCallback((updater: (elements: WhiteboardElement[]) => WhiteboardElement[]) => {
    setData(prev => {
      const newElements = updater(prev.elements);
      const newData = { ...prev, elements: newElements };
      pushHistory(newElements, prev.groups);
      saveToBackend(newData);
      return newData;
    });
  }, [pushHistory, saveToBackend]);

  const updateGroups = useCallback((updater: (groups: WhiteboardGroup[]) => WhiteboardGroup[]) => {
    setData(prev => {
      const newGroups = updater(prev.groups);
      const newData = { ...prev, groups: newGroups };
      pushHistory(prev.elements, newGroups);
      saveToBackend(newData);
      return newData;
    });
  }, [pushHistory, saveToBackend]);

  const groupsApi = useWhiteboardGroups(data.groups, updateGroups);

  const addElement = useCallback((element: WhiteboardElement) => {
    updateElements(elements => [...elements, element]);
  }, [updateElements]);

  const removeElements = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setData(prev => {
      const newElements = prev.elements.filter(el => !idSet.has(el.id));
      const newGroups = prev.groups
        .map(g => ({ ...g, elementIds: g.elementIds.filter(id => !idSet.has(id)) }))
        .filter(g => g.elementIds.length > 1);
      const newData = { ...prev, elements: newElements, groups: newGroups };
      pushHistory(newElements, newGroups);
      saveToBackend(newData);
      return newData;
    });
    setInteraction(prev => ({
      ...prev,
      selectedIds: new Set([...prev.selectedIds].filter(id => !idSet.has(id))),
    }));
  }, [pushHistory, saveToBackend]);

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
    updateElements(elements =>
      elements.map(el => {
        if (el.id !== id) return el;
        if (el.type === 'stroke') {
          const scaleX = el.width > 0 ? bounds.width / el.width : 1;
          const scaleY = el.height > 0 ? bounds.height / el.height : 1;
          const scaledPoints = (el as WhiteboardStrokeElement).points.map(p => ({
            ...p,
            x: p.x * scaleX,
            y: p.y * scaleY,
          }));
          return { ...el, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, points: scaledPoints } as WhiteboardElement;
        }
        return { ...el, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } as WhiteboardElement;
      })
    );
  }, [updateElements]);

  const rotateElement = useCallback((id: string, rotation: number) => {
    updateElements(elements =>
      elements.map(el => (el.id === id ? { ...el, rotation } as WhiteboardElement : el))
    );
  }, [updateElements]);

  const duplicateElements = useCallback((ids: string[]) => {
    updateElements(elements => {
      const copies: WhiteboardElement[] = [];
      for (const el of elements) {
        if (ids.includes(el.id)) {
          copies.push({
            ...structuredClone(el),
            id: crypto.randomUUID(),
            x: el.x + 20,
            y: el.y + 20,
          } as WhiteboardElement);
        }
      }
      return [...elements, ...copies];
    });
  }, [updateElements]);

  // Clipboard
  const clipboardRef = useRef<WhiteboardElement[]>([]);

  const copySelectedElements = useCallback((ids: string[]) => {
    const toCopy = latestDataRef.current.elements.filter(el => ids.includes(el.id));
    clipboardRef.current = toCopy.map(el => structuredClone(el));
  }, [latestDataRef]);

  const pasteElements = useCallback((offsetX = 20, offsetY = 20) => {
    if (clipboardRef.current.length === 0) return;
    updateElements(elements => {
      const maxZ = Math.max(...elements.map(el => el.zIndex), 0);
      const pasted = clipboardRef.current.map((el, i) => ({
        ...structuredClone(el),
        id: crypto.randomUUID(),
        x: el.x + offsetX,
        y: el.y + offsetY,
        zIndex: maxZ + i + 1,
      } as WhiteboardElement));
      clipboardRef.current = pasted.map(el => structuredClone(el));
      return [...elements, ...pasted];
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

  // Tool state
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

  // Viewport
  const setViewport = useCallback((viewport: { x: number; y: number; zoom: number }) => {
    setData(prev => ({ ...prev, viewport }));
  }, []);

  const zoomToFit = useCallback(() => {
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
    const canvasWidth = window.innerWidth - 300;
    const canvasHeight = window.innerHeight - 100;
    const zoom = Math.min(canvasWidth / contentWidth, canvasHeight / contentHeight, 2);
    setViewport({
      x: -(minX - padding) * zoom + (canvasWidth - contentWidth * zoom) / 2,
      y: -(minY - padding) * zoom + (canvasHeight - contentHeight * zoom) / 2,
      zoom: Math.max(0.1, zoom),
    });
  }, [data.elements, setViewport]);

  // Grid
  const { gridSnap, gridSize } = useGridSettings();
  const { toggleGrid, toggleSnap } = useGridToggles();

  const snapToGrid = useCallback((point: { x: number; y: number }): { x: number; y: number } => {
    if (!gridSnap) return point;
    return {
      x: Math.round(point.x / gridSize) * gridSize,
      y: Math.round(point.y / gridSize) * gridSize,
    };
  }, [gridSnap, gridSize]);

  // Flush pending save on unmount
  /* eslint-disable react-hooks/exhaustive-deps -- Cleanup intentionally reads mutable refs to flush the latest pending save at unmount; refs are stable and flushSave is the only meaningful dependency. */
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        flushSave(latestDataRef.current);
      }
    };
  }, [flushSave]);
  /* eslint-enable react-hooks/exhaustive-deps */

  return {
    node,
    data,
    settings,
    interaction,
    addElement,
    removeElements,
    updateElement,
    moveElements,
    resizeElement,
    rotateElement,
    duplicateElements,
    copySelectedElements,
    pasteElements,
    bringToFront,
    sendToBack,
    alignElements,
    distributeElements,
    ...creators,
    ...groupsApi,
    setTool,
    selectElements,
    clearSelection,
    setInteraction,
    setViewport,
    zoomToFit,
    toggleGrid,
    toggleSnap,
    snapToGrid,
    undo,
    redo,
    setSettings,
    saveToBackend,
  };
}

export type UseWhiteboardReturn = ReturnType<typeof useWhiteboard>;
