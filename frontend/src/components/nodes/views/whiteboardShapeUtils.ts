import type { WhiteboardShapeElement } from '@/types/whiteboard';
import { getShapePathGenerator } from './whiteboardShapeRegistry';
import './registerWhiteboardShapes';

export function getShapePath(type: WhiteboardShapeElement['shapeType'], w: number, h: number): string {
  const generator = getShapePathGenerator(type);
  if (generator) {
    return generator.getPath(w, h);
  }
  // Default fallback: rectangle
  return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
}
