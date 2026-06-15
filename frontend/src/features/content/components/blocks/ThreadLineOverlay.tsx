/**
 * ThreadLineOverlay — List-level continuous indentation guide lines.
 *
 * Renders one continuous SVG line per visible parent-descendant chain.
 * Each line starts slightly below the parent bullet (leaving a small gap)
 * and runs to the last descendant bullet. Active-path L-connectors are
 * drawn with rounded elbows on top of the guide lines.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import './ThreadLineOverlay.css';

interface VirtualItemInfo {
  index: number;
  start: number;
  end: number;
}

export interface ThreadLineOverlayProps {
  /** Ref to the list container (used for coordinate frames and resize observation). */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Flat list of visible nodes, used to map depths to DOM rows. */
  flatNodes: Array<{ node: { uuid: string }; depth: number; isGhost?: boolean }>;
  /** True when the list is virtualized. */
  virtualized?: boolean;
  /** Visible virtual rows when virtualized. */
  virtualItems?: VirtualItemInfo[];
  /** Called when a guide-line is clicked; receives the parent block UUID. */
  onLineClick?: (blockId: string) => void;
}

interface LineSpan {
  x: number;
  yStart: number;
  yEnd: number;
  blockId: string;
  isActivePath: boolean;
}

interface Connector {
  x: number;
  y: number;
}

function getBulletCenterOffset(): number {
  const wrapperSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bullet-wrapper-size'));
  return Number.isFinite(wrapperSize) ? wrapperSize / 2 : 11;
}

function getLineStartTrim(): number {
  const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thread-line-bullet-gap'));
  return Number.isFinite(gap) ? gap : 6;
}

export const ThreadLineOverlay = memo(function ThreadLineOverlay({
  containerRef,
  flatNodes,
  virtualized = false,
  virtualItems,
  onLineClick,
}: ThreadLineOverlayProps) {
  const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);
  const isEditing = activeBlockId != null;
  const [spans, setSpans] = useState<LineSpan[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const rafRef = useRef<number>(0);

  const computeOverlay = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      setSpans([]);
      setConnectors([]);
      setSize({ width: 0, height: 0 });
      return;
    }

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const bulletCenter = getBulletCenterOffset();
      const startTrim = getLineStartTrim();
      const step = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--block-indent-step')) || 24;
      const containerRect = container.getBoundingClientRect();

      // Build active-path set from runtime when a block is being edited.
      const activePath = new Set<string>();
      if (activeBlockId) {
        let current = getNodeGraphRuntime().getNode(activeBlockId);
        while (current) {
          activePath.add(current.blockId);
          if (!current.parentId) break;
          current = getNodeGraphRuntime().getNode(current.parentId);
        }
      }

      // Collect visible rows with coordinates.
      const rows: { depth: number; uuid: string; y: number; x: number }[] = [];

      if (virtualized && virtualItems) {
        const scrollTop = container.scrollTop;
        for (const vi of virtualItems) {
          const fn = flatNodes[vi.index];
          if (!fn || fn.isGhost) continue;
          rows.push({
            depth: fn.depth,
            uuid: fn.node.uuid,
            y: vi.start + (vi.end - vi.start) / 2 - scrollTop,
            x: fn.depth * step + bulletCenter,
          });
        }
      } else {
        for (const fn of flatNodes) {
          if (fn.isGhost) continue;
          const el = container.querySelector(`.node-block[data-block-id="${fn.node.uuid}"]`) as HTMLElement | null;
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          rows.push({
            depth: fn.depth,
            uuid: fn.node.uuid,
            y: rect.top - containerRect.top + rect.height / 2,
            x: rect.left - containerRect.left + bulletCenter,
          });
        }
      }

      if (rows.length === 0) {
        setSpans([]);
        setConnectors([]);
        setSize({ width: containerRect.width, height: containerRect.height });
        return;
      }

      // Compute the last descendant index for every row using a monotonic stack.
      const lastDescendantIndex: (number | null)[] = new Array(rows.length).fill(null);
      const stack: number[] = [];

      for (let i = 0; i < rows.length; i++) {
        while (stack.length > 0 && rows[stack[stack.length - 1]].depth >= rows[i].depth) {
          const parentIndex = stack.pop()!;
          lastDescendantIndex[parentIndex] = i - 1;
        }
        stack.push(i);
      }
      while (stack.length > 0) {
        const parentIndex = stack.pop()!;
        lastDescendantIndex[parentIndex] = rows.length - 1;
      }

      // Draw one continuous vertical line per parent with descendants.
      const newSpans: LineSpan[] = [];
      for (let i = 0; i < rows.length; i++) {
        const last = lastDescendantIndex[i];
        if (last == null || last <= i) continue;
        const row = rows[i];
        const yStart = row.y + startTrim;
        const yEnd = rows[last].y;
        if (yEnd <= yStart) continue;

        newSpans.push({
          x: row.x,
          yStart,
          yEnd,
          blockId: row.uuid,
          isActivePath: activePath.has(row.uuid),
        });
      }

      // Compute L-connectors for the active path.
      const newConnectors: Connector[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!activePath.has(row.uuid)) continue;

        for (let j = i - 1; j >= 0; j--) {
          if (rows[j].depth === row.depth - 1) {
            newConnectors.push({ x: rows[j].x, y: row.y });
            break;
          }
          if (rows[j].depth < row.depth - 1) break;
        }
      }

      setSpans(newSpans);
      setConnectors(newConnectors);
      setSize({ width: containerRect.width, height: containerRect.height });
    });
  }, [containerRef, flatNodes, activeBlockId, virtualized, virtualItems]);

  useEffect(() => {
    computeOverlay();
  }, [computeOverlay]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(computeOverlay);
    observer.observe(container);

    const onTransitionEnd = () => computeOverlay();
    container.addEventListener('transitionend', onTransitionEnd);

    return () => {
      observer.disconnect();
      container.removeEventListener('transitionend', onTransitionEnd);
      cancelAnimationFrame(rafRef.current);
    };
  }, [computeOverlay, containerRef]);

  if (spans.length === 0) return null;

  const handleLineClick = (blockId: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onLineClick?.(blockId);
  };

  return (
    <svg
      className={`thread-line-overlay ${isEditing ? 'thread-line-overlay--editing' : ''}`}
      width={size.width}
      height={size.height}
      aria-hidden="true"
    >
      {spans.map((span, index) => (
        <g
          key={`span-${index}`}
          className={`thread-line-overlay__group ${span.isActivePath ? 'thread-line-overlay__group--active' : ''}`}
        >
          <line
            className="thread-line-overlay__line"
            x1={span.x}
            y1={span.yStart}
            x2={span.x}
            y2={span.yEnd}
          />
          <line
            className="thread-line-overlay__hit"
            x1={span.x}
            y1={span.yStart}
            x2={span.x}
            y2={span.yEnd}
            onClick={handleLineClick(span.blockId)}
          />
        </g>
      ))}
      {connectors.map((connector, index) => {
        const step = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--block-indent-step')) || 24;
        const r = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thread-line-connector-radius')) || 6;
        return (
          <path
            key={`conn-${index}`}
            className="thread-line-overlay__connector"
            d={`M ${connector.x} ${connector.y - r} L ${connector.x} ${connector.y} L ${connector.x + step} ${connector.y}`}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
});
