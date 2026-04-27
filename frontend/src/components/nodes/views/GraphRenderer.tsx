/**
 * GraphRenderer
 *
 * Production-ready WebGL2 canvas component backed by the SGE physics worker.
 * This is a low-level rendering primitive — it owns the <canvas>, the WebGL2
 * context, the physics Web Worker, and all pointer/zoom interaction.
 *
 * For the full graph view with settings panels, search, class colors, and
 * visibility filters, use GraphView instead.
 *
 * Features
 * ─────────
 * • WebGL2 GPU-accelerated rendering at 60 FPS.
 * • Multi-scale force physics running in a dedicated Web Worker.
 * • Drag to pan, scroll-wheel to zoom, pointer-drag on nodes to reposition.
 * • Debug stats overlay (toggled via `showStats` prop).
 * • Node click / double-click callbacks.
 * • Reheat / recenter controls exposed via imperative ref.
 * • Graceful fallback message when WebGL2 is unavailable.
 */

import { useRef, useCallback, memo, forwardRef, useImperativeHandle } from 'react';
import { useGraphRenderer, type GraphRendererOptions } from './useGraphRenderer';
import type { SGEConfig } from './SemanticGraphEngine';
import type { GraphNode, GraphLink } from './viewTypes';
import './GraphRenderer.css';

// ─── Imperative ref API ───────────────────────────────────────────────────────

export interface GraphRendererRef {
  /** Restart the physics cooling schedule. */
  reheat: () => void;
  /** Pause the physics tick loop. */
  pauseSimulation: () => void;
  /** Resume the physics tick loop. */
  resumeSimulation: () => void;
  /** Centre the camera on the graph centroid. */
  recenter: () => void;
  /** Pan the camera by a screen-pixel delta. */
  panBy: (dx: number, dy: number) => void;
  /** Zoom by a factor (1 = no change, >1 = in, <1 = out). */
  zoomBy: (factor: number) => void;
  /** Clear the current node selection. */
  clearSelection: () => void;
  /** Live-update SGE config without recreating the worker. */
  setConfig: (cfg: Partial<SGEConfig>) => void;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface GraphRendererProps {
  /** Graph nodes. */
  nodes: GraphNode[];
  /** Graph edges. */
  edges: GraphLink[];
  /** Optional partial SGE physics config. */
  config?: Partial<SGEConfig>;
  /** Scale node size by connection count. Default: true */
  sizeByConnections?: boolean;
  /** Base node radius in world units (used when sizeByConnections=false or as the minimum). Default: 7 */
  baseNodeRadius?: number;
  /** Show debug stats overlay. Default: false */
  showStats?: boolean;
  /** CSS class applied to the root element. */
  className?: string;
  /** Called when user clicks (not drags) a node. */
  onNodeClick?: (nodeId: number) => void;
  /** Called when user double-clicks a node. */
  onNodeDblClick?: (nodeId: number) => void;
  /** Called when user clicks on empty canvas space (no node hit). */
  onEmptyClick?: () => void;
}

// ─── WebGL2 availability check ────────────────────────────────────────────────

function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

// ─── Stats overlay ────────────────────────────────────────────────────────────

interface StatsOverlayProps {
  alpha: number;
  energy: number;
  ticks: number;
  fps: number;
  nodeCount: number;
  edgeCount: number;
  visibleNodes: number;
  visibleEdges: number;
}

function StatsOverlay({
  alpha, energy, ticks, fps,
  nodeCount, edgeCount,
  visibleNodes, visibleEdges,
}: StatsOverlayProps) {
  return (
    <div className="sge-stats">
      <span>{fps} fps</span>
      <span>α {alpha.toFixed(4)}</span>
      <span>E {energy.toFixed(4)}</span>
      <span>t {ticks}</span>
      <span>{visibleNodes}/{nodeCount} nodes</span>
      <span>{visibleEdges}/{edgeCount} edges</span>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export const GraphRenderer = memo(forwardRef<GraphRendererRef, GraphRendererProps>(function GraphRenderer({
  nodes,
  edges,
  config,
  sizeByConnections = true,
  baseNodeRadius,
  showStats = false,
  className = '',
  onNodeClick,
  onNodeDblClick,
  onEmptyClick,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Check WebGL2 once (stable ref)
  const webgl2Available = useRef(hasWebGL2()).current;

  const graphOpts: GraphRendererOptions = {
    nodes,
    edges,
    config,
    sizeByConnections,
    baseNodeRadius,
    onNodeClick,
    onNodeDblClick,
    onEmptyClick,
  };

  const {
    canvasRef,
    labelCanvasRef,
    stats,
    hoveredNode,
    reheat,
    pause,
    resume,
    recenter,
    panBy,
    zoomBy,
    clearSelection,
    setConfig: _setConfig,
    _pointerDown,
    _pointerMove,
    _pointerUp,
    _wheel,
    _dblClick,
  } = useGraphRenderer(graphOpts) as ReturnType<typeof useGraphRenderer> & {
    _pointerDown:  React.PointerEventHandler<HTMLCanvasElement>;
    _pointerMove:  React.PointerEventHandler<HTMLCanvasElement>;
    _pointerUp:    React.PointerEventHandler<HTMLCanvasElement>;
    _wheel:        React.WheelEventHandler<HTMLCanvasElement>;
    _dblClick:     React.MouseEventHandler<HTMLCanvasElement>;
  };

  // Expose imperative API to parent via ref
  useImperativeHandle(ref, () => ({
    reheat,
    pauseSimulation: pause,
    resumeSimulation: resume,
    recenter,
    panBy,
    zoomBy,
    clearSelection,
    setConfig: _setConfig,
  }), [reheat, pause, resume, recenter, panBy, zoomBy, clearSelection, _setConfig]);

  // Prevent native context menu on right-click
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  if (!webgl2Available) {
    return (
      <div className={`sge-graph-view sge-graph-view--no-webgl ${className}`}>
        <p className="sge-graph-view__no-webgl-msg">
          WebGL 2 is required for the graph view but is not available in this browser.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`sge-graph-view ${className}`}
    >
      {/* WebGL canvas — fills the container */}
      <canvas
        ref={canvasRef}
        className="sge-graph-view__canvas"
        onPointerDown={_pointerDown}
        onPointerMove={_pointerMove}
        onPointerUp={_pointerUp}
        onPointerCancel={_pointerUp}
        onWheel={_wheel}
        onDoubleClick={_dblClick}
        onContextMenu={onContextMenu}
      />

      {/* 2-D label overlay (pointer-events:none so clicks pass through) */}
      <canvas
        ref={labelCanvasRef}
        className="sge-graph-view__label-canvas"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />

      {/* Optional stats overlay */}
      {showStats && (
        <StatsOverlay
          alpha={stats.alpha}
          energy={stats.energy}
          ticks={stats.ticks}
          fps={stats.fps}
          nodeCount={stats.nodeCount}
          edgeCount={stats.edgeCount}
          visibleNodes={stats.visibleNodes}
          visibleEdges={stats.visibleEdges}
        />
      )}

      {/* Hover tooltip — Obsidian-style node preview card */}
      {hoveredNode && (
        <div
          className="sge-graph-tooltip"
          style={{
            left: hoveredNode.screenX + 12,
            top: hoveredNode.screenY + 12,
          }}
        >
          <span className="sge-graph-tooltip__name">{hoveredNode.name}</span>
        </div>
      )}
    </div>
  );
}));

export type { GraphRendererOptions };
