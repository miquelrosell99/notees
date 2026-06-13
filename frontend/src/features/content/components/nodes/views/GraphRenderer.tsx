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

import { useRef, useCallback, useEffect, memo, forwardRef, useImperativeHandle } from 'react';
import { useGraphRenderer, type GraphRendererOptions } from './useGraphRenderer';
import type { SGEPhysicsConfig } from './sge';
import type { GraphNode, GraphLink } from './viewTypes';
import './GraphRenderer.css';

// ─── Imperative ref API ───────────────────────────────────────────────────────

export interface GraphRendererRef {
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
  setConfig: (cfg: SGEPhysicsConfig) => void;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface GraphRendererProps {
  /** Graph nodes. */
  nodes: GraphNode[];
  /** Graph edges. */
  edges: GraphLink[];
  /** Semantic physics config — translated to raw constants by the worker. */
  config?: SGEPhysicsConfig;
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
  /** Enable curved edges. Default: true */
  curvedEdges?: boolean;
  /** Enable colored edge gradients. Default: true */
  coloredEdges?: boolean;
  /** Enable tapered edge widths. Default: true */
  taperedEdges?: boolean;
  /** Enable link-type LOD based on zoom. Default: true */
  enableLinkLOD?: boolean;
  /** Node IDs that are on a highlighted path. */
  pathNodeIds?: Set<number>;
  /** Edge keys ("min-max") that are on a highlighted path. */
  pathEdgeKeys?: Set<string>;
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
  energy: number;
  ticks: number;
  fps: number;
  nodeCount: number;
  edgeCount: number;
  visibleNodes: number;
  visibleEdges: number;
}

function StatsOverlay({
  energy, ticks, fps,
  nodeCount, edgeCount,
  visibleNodes, visibleEdges,
}: StatsOverlayProps) {
  return (
    <div className="sge-stats">
      <span>{fps} fps</span>
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
  curvedEdges = true,
  coloredEdges = false,
  taperedEdges = false,
  enableLinkLOD = true,
  pathNodeIds,
  pathEdgeKeys,
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
    curvedEdges,
    coloredEdges,
    taperedEdges,
    enableLinkLOD,
    pathNodeIds,
    pathEdgeKeys,
  };

  const {
    canvasRef,
    labelCanvasRef,
    stats,
    hoveredNode,
    hoveredEdge,
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
    pauseSimulation: pause,
    resumeSimulation: resume,
    recenter,
    panBy,
    zoomBy,
    clearSelection,
    setConfig: _setConfig,
  }), [pause, resume, recenter, panBy, zoomBy, clearSelection, _setConfig]);

  // Prevent native context menu on right-click
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Attach wheel listener natively (non-passive) so preventDefault works for zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      _wheel(e as unknown as React.WheelEvent<HTMLCanvasElement>);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [_wheel]);

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
        aria-label="Graph view of your pages and links"
        role="img"
        onPointerDown={_pointerDown}
        onPointerMove={_pointerMove}
        onPointerUp={_pointerUp}
        onPointerCancel={_pointerUp}
        onDoubleClick={_dblClick}
        onContextMenu={onContextMenu}
      />

      {/* 2-D label overlay (pointer-events:none so clicks pass through) */}
      <canvas
        ref={labelCanvasRef}
        className="sge-graph-view__label-canvas"
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />

      {/* Optional stats overlay */}
      {showStats && (
        <StatsOverlay
          energy={stats.energy}
          ticks={stats.ticks}
          fps={stats.fps}
          nodeCount={stats.nodeCount}
          edgeCount={stats.edgeCount}
          visibleNodes={stats.visibleNodes}
          visibleEdges={stats.visibleEdges}
        />
      )}

      {/* Hover tooltip — node preview card */}
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

      {/* Edge hover tooltip */}
      {hoveredEdge && (
        <div
          className="sge-graph-tooltip sge-graph-tooltip--edge"
          style={{
            left: hoveredEdge.screenX + 12,
            top: hoveredEdge.screenY + 12,
          }}
        >
          <span className="sge-graph-tooltip__edge-type">{hoveredEdge.type}</span>
        </div>
      )}
    </div>
  );
}));

export type { GraphRendererOptions };
