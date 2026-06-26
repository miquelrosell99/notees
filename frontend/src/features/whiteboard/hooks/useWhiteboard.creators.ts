/**
 * useWhiteboard creators hook — factory functions for new elements
 */

import { useCallback } from 'react';
import type {
  WhiteboardData,
  WhiteboardSettings,
  Point,
  Bounds,
  StrokePoint,
  WhiteboardCardElement,
  WhiteboardShapeElement,
  WhiteboardStrokeElement,
  WhiteboardTextElement,
  WhiteboardConnectorElement,
  WhiteboardLineElement,
  ConnectorEndpoint,
} from '@/features/whiteboard/types/whiteboard';
import { createElementId, getStrokeBounds } from '@/features/whiteboard/types/whiteboard';

export function useWhiteboardCreators(data: WhiteboardData, settings: WhiteboardSettings) {
  const createCard = useCallback((nodeUuid: string, position: Point): WhiteboardCardElement => {
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
      nodeUuid,
      collapsed: false,
      color: null,
      showChildren: true,
      cardMode: 'block',
    };
  }, [data.elements]);

  const createReferenceCard = useCallback((nodeUuid: string, position: Point, refBlockUuid?: string): WhiteboardCardElement => {
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
      nodeUuid,
      refBlockUuid,
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
      strokeStyle: penSettings.strokeStyle,
      tool,
    };
  }, [data.elements, settings.pen, settings.highlighter]);

  const createLine = useCallback((start: Point, end: Point): WhiteboardLineElement => {
    const maxZ = Math.max(...data.elements.map(el => el.zIndex), 0);
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.max(Math.abs(end.x - start.x), 10);
    const height = Math.max(Math.abs(end.y - start.y), 10);
    const lineFlipped = (start.x > end.x) !== (start.y > end.y);
    return {
      id: createElementId(),
      type: 'line',
      x,
      y,
      width,
      height,
      rotation: 0,
      locked: false,
      opacity: 1,
      zIndex: maxZ + 1,
      lineFlipped,
      stroke: settings.shape.stroke,
      strokeWidth: settings.shape.strokeWidth,
      strokeStyle: settings.shape.strokeStyle,
    };
  }, [data.elements, settings.shape]);

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

  return {
    createCard,
    createReferenceCard,
    createShape,
    createStroke,
    createLine,
    createText,
    createConnector,
  };
}
