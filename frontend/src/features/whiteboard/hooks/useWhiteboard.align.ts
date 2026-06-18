/**
 * useWhiteboard align hook — alignment and distribution utilities
 */

import { useCallback } from 'react';
import type { WhiteboardElement } from '@/features/whiteboard/types/whiteboard';

type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
type DistributeMode = 'horizontal' | 'vertical';

export function useWhiteboardAlign(
  updateElements: (updater: (elements: WhiteboardElement[]) => WhiteboardElement[]) => void,
) {
  const alignElements = useCallback((ids: string[], mode: AlignMode) => {
    updateElements(elements => {
      const selected = elements.filter(el => ids.includes(el.id));
      if (selected.length < 2) return elements;
      let value = 0;
      switch (mode) {
        case 'left':   value = Math.min(...selected.map(e => e.x)); break;
        case 'center': value = selected.reduce((s, e) => s + e.x + e.width / 2, 0) / selected.length; break;
        case 'right':  value = Math.max(...selected.map(e => e.x + e.width)); break;
        case 'top':    value = Math.min(...selected.map(e => e.y)); break;
        case 'middle': value = selected.reduce((s, e) => s + e.y + e.height / 2, 0) / selected.length; break;
        case 'bottom': value = Math.max(...selected.map(e => e.y + e.height)); break;
      }
      return elements.map(el => {
        if (!ids.includes(el.id)) return el;
        switch (mode) {
          case 'left':   return { ...el, x: value } as WhiteboardElement;
          case 'center': return { ...el, x: value - el.width / 2 } as WhiteboardElement;
          case 'right':  return { ...el, x: value - el.width } as WhiteboardElement;
          case 'top':    return { ...el, y: value } as WhiteboardElement;
          case 'middle': return { ...el, y: value - el.height / 2 } as WhiteboardElement;
          case 'bottom': return { ...el, y: value - el.height } as WhiteboardElement;
        }
        return el;
      });
    });
  }, [updateElements]);

  const distributeElements = useCallback((ids: string[], mode: DistributeMode) => {
    updateElements(elements => {
      const selected = elements.filter(el => ids.includes(el.id));
      if (selected.length < 3) return elements;
      const sorted = [...selected].sort((a, b) =>
        mode === 'horizontal' ? a.x - b.x : a.y - b.y
      );
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const totalSpace = mode === 'horizontal'
        ? last.x + last.width - first.x
        : last.y + last.height - first.y;
      const totalSize = sorted.reduce((s, e) => s + (mode === 'horizontal' ? e.width : e.height), 0);
      const gap = (totalSpace - totalSize) / (sorted.length - 1);
      let pos = mode === 'horizontal' ? first.x : first.y;
      const updates = new Map<string, Partial<WhiteboardElement>>();
      for (const el of sorted) {
        updates.set(el.id, mode === 'horizontal' ? { x: pos } : { y: pos });
        pos += (mode === 'horizontal' ? el.width : el.height) + gap;
      }
      return elements.map(el => (updates.has(el.id) ? { ...el, ...updates.get(el.id) } as WhiteboardElement : el));
    });
  }, [updateElements]);

  return { alignElements, distributeElements };
}
