/**
 * BulletLineOverlay — List-level indentation guide lines and active bullet thread.
 *
 * Renders faint vertical guide lines (BulletLine) for every parent-descendant
 * chain, plus a continuous primary-colored BulletThread along the active editing
 * path, connecting bullet to bullet with rounded elbows.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import './BulletLineOverlay.css';
import { getOperationRuntime } from '@/runtime';
import { getAncestors } from '@/runtime/graphHelpers';

interface VirtualItemInfo {
  index: number;
  start: number;
  end: number;
}

export interface BulletLineOverlayProps {
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
}

interface Connector {
  x: number;
  y: number;
}

interface Point {
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

function buildThreadPath(points: Point[], radius: number): string {
  if (points.length < 2) return '';
  const segments: string[] = [];
  const clampedRadius = Math.max(1, Math.min(radius, 12));

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dy = curr.y - prev.y;
    const r = Math.min(clampedRadius, Math.abs(dy) / 2);

    if (i === 1) {
      segments.push(`M ${prev.x} ${prev.y}`);
    }

    if (dy <= r * 2) {
      // Not enough vertical room for a full elbow; draw a straight diagonal.
      segments.push(`L ${curr.x} ${curr.y}`);
    } else {
      segments.push(`L ${prev.x} ${curr.y - r}`);
      segments.push(`A ${r} ${r} 0 0 0 ${prev.x + r} ${curr.y}`);
      segments.push(`L ${curr.x} ${curr.y}`);
    }
  }

  return segments.join(' ');
}

export const BulletLineOverlay = memo(function BulletLineOverlay({
  containerRef,
  flatNodes,
  virtualized = false,
  virtualItems,
  onLineClick,
}: BulletLineOverlayProps) {
  const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);
  const showBulletThread = useSettingsStore((s) => s.showBulletThread);
  const isFocusMode = useNavigationStore((s) => s.viewMode === 'focus');
  const isEditing = activeBlockId != null;

  const [spans, setSpans] = useState<LineSpan[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [activePathChain, setActivePathChain] = useState<Point[]>([]);
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
      const runtime = getOperationRuntime();
      const activeAncestors = activeBlockId ? getAncestors(runtime, activeBlockId) : [];
      const activePath = new Set<string>(activeAncestors.map((n) => n.blockId));
      if (activeBlockId) activePath.add(activeBlockId);

      // Collect visible rows with coordinates.
      const rows: { depth: number; blockUuid: string; y: number; x: number }[] = [];

      if (virtualized && virtualItems) {
        // Measure the actual rendered rows so guide lines match the virtualized
        // layout (including dynamic heights and the scroll-margin offset).
        for (const vi of virtualItems) {
          const fn = flatNodes[vi.index];
          if (!fn || fn.isGhost) continue;
          const el = container.querySelector(`.node-block[data-block-id="${fn.node.uuid}"]`) as HTMLElement | null;
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          rows.push({
            depth: fn.depth,
            blockUuid: fn.node.uuid,
            y: rect.top - containerRect.top + rect.height / 2,
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
            blockUuid: fn.node.uuid,
            y: rect.top - containerRect.top + rect.height / 2,
            x: rect.left - containerRect.left + bulletCenter,
          });
        }
      }

      if (rows.length === 0) {
        setSpans([]);
        setConnectors([]);
        setActivePathChain([]);
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
          blockId: row.blockUuid,
        });
      }

      // Compute L-connectors for the active path.
      const newConnectors: Connector[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!activePath.has(row.blockUuid)) continue;

        for (let j = i - 1; j >= 0; j--) {
          if (rows[j].depth === row.depth - 1) {
            newConnectors.push({ x: rows[j].x, y: row.y });
            break;
          }
          if (rows[j].depth < row.depth - 1) break;
        }
      }

      // Build the continuous active-path chain from root to active block,
      // using only the visible rows for coordinates.
      const newActivePathChain: Point[] = [];
      if (activeBlockId) {
        const chain: Point[] = [];
        for (const ancestor of [...activeAncestors].reverse()) {
          const row = rows.find((r) => r.blockUuid === ancestor.blockId);
          if (row) chain.push({ x: row.x, y: row.y });
        }
        const activeRow = rows.find((r) => r.blockUuid === activeBlockId);
        if (activeRow) chain.push({ x: activeRow.x, y: activeRow.y });
        newActivePathChain.push(...chain);
      }

      setSpans(newSpans);
      setConnectors(newConnectors);
      setActivePathChain(newActivePathChain);
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

  if (!showBulletThread || isFocusMode || (spans.length === 0 && activePathChain.length < 2)) return null;

  const handleLineClick = (blockId: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onLineClick?.(blockId);
  };

  return (
    <svg
      className={`bullet-line-overlay ${isEditing ? 'bullet-line-overlay--editing' : ''}`}
      width={size.width}
      height={size.height}
      aria-hidden="true"
    >
      {spans.map((span, index) => (
        <g
          key={`span-${index}`}
          className="bullet-line__group"
        >
          <line
            className="bullet-line"
            x1={span.x}
            y1={span.yStart}
            x2={span.x}
            y2={span.yEnd}
          />
          <line
            className="bullet-line__hit"
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
            className="bullet-line__connector"
            d={`M ${connector.x} ${connector.y - r} L ${connector.x} ${connector.y} L ${connector.x + step} ${connector.y}`}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
      {activePathChain.length >= 2 && (
        <path
          className="bullet-thread"
          d={buildThreadPath(activePathChain, 5)}
          fill="none"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
});