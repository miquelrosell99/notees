/**
 * GraphView — the workspace graph (§34.80): every page and class as a node,
 * every rolled-up link as an edge, force-directed in a worker, drawn by the
 * WebGL2 renderer with a Canvas 2D label overlay.
 *
 * Owner rulings baked in: blocks NEVER render as nodes (they surface only as
 * edge evidence); the journal chain is in the topology but filtered off by
 * default; the semantic (co-occurrence) family renders weighted, sparsified,
 * and toggleable alongside the structural families.
 *
 * The component also serves as the `graph` view mode on node collections
 * (`items` scopes the topology to the collection).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GraphEdge, GraphEdgeKind, GraphTopology } from "@notees/store";

import type { NodeCollectionProps } from "../types.js";
import { registerView } from "../registry.js";
import { Icon } from "../../Icon.js";
import { EmptyState } from "../../components/ui/EmptyState.js";
import { Slider } from "../../components/ui/Slider.js";
import { resolveCssColor } from "../../components/ui/colorPresets.js";

import {
  DEFAULT_GRAPH_SETTINGS,
  LINK_TYPE_IDS,
  applyGraphSettings,
  edgeMaskForZoom,
  graphCounts,
  type GraphSettings,
} from "./filter.js";
import { EngineController, type EngineFrame } from "./engineController.js";
import { GraphWebGLRenderer, type RendererEdge } from "./renderer/webglRenderer.js";
import { drawLabels, type LabelFrame } from "./renderer/labelCanvas.js";
import { graphTheme } from "./renderer/theme.js";
import "./GraphView.css";

type PhysicsPreset = "sparse" | "balanced" | "compact" | "clustered";
type NodeSizeMode = "uniform" | "connections";

interface GraphPrefs {
  showClasses: boolean;
  showJournal: boolean;
  families: Record<GraphEdgeKind, boolean>;
  semanticTopK: number;
  semanticMinWeight: number;
  preset: PhysicsPreset;
  nodeSize: NodeSizeMode;
  paused: boolean;
}

const FAMILY_LABELS: Array<{ key: GraphEdgeKind; label: string }> = [
  { key: "mention", label: "Mentions" },
  { key: "property", label: "Properties" },
  { key: "parent", label: "Parents" },
  { key: "class", label: "Classes" },
  { key: "semantic", label: "Semantic" },
];

const POSITIONS_KEY = (workspaceId: string): string => `notees.graph.positions.${workspaceId}`;

function loadCachedPositions(workspaceId: string): Map<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY(workspaceId));
    if (raw === null) return new Map();
    const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function cachePositions(workspaceId: string, order: string[], positions: Float32Array): void {
  try {
    const record: Record<string, { x: number; y: number }> = {};
    const limit = Math.min(order.length, 12000);
    for (let i = 0; i < limit; i++) {
      record[order[i]!] = { x: positions[i * 2]!, y: positions[i * 2 + 1]! };
    }
    localStorage.setItem(POSITIONS_KEY(workspaceId), JSON.stringify(record));
  } catch {
    // Best effort — quota or privacy mode just skips the warm start.
  }
}

function hexToRgba(hex: string, alpha = 1): [number, number, number, number] | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return undefined;
  const rgb = parseInt(match[1]!, 16);
  return [((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255, alpha];
}

export function GraphView({ client, items, onNodeClick }: NodeCollectionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<GraphWebGLRenderer | null>(null);
  const engineRef = useRef<EngineController | null>(null);
  const cameraRef = useRef({ x: 0, y: 0, zoom: 0.5 });
  const frameRef = useRef<EngineFrame | null>(null);
  const dirtyRef = useRef(false);
  const draggingRef = useRef<{ nodeId: string } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; camX: number; camY: number } | null>(null);

  // Loop-visible mirrors — hover/selection/prefs must NOT rebuild the GL stack.
  const loopStateRef = useRef<{ hovered: string | null; selected: string | null; paused: boolean }>({
    hovered: null,
    selected: null,
    paused: false,
  });
  const nodeSizeRef = useRef<NodeSizeMode>("uniform");
  const presetRef = useRef<PhysicsPreset>("balanced");

  const [topology, setTopology] = useState<GraphTopology | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<GraphPrefs>(() => ({
    ...DEFAULT_GRAPH_SETTINGS,
    preset: "balanced",
    nodeSize: "uniform",
    paused:
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  const [hover, setHover] = useState<
    | { kind: "node"; id: string; x: number; y: number }
    | { kind: "edge"; edge: GraphEdge; x: number; y: number }
    | null
  >(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [, setFps] = useState(0);

  const scope = useMemo(
    () => (items !== undefined ? new Set(items.map((item) => item.node.id)) : undefined),
    [items],
  );

  /** Load (or reload) the topology; debounced caller on subscribe below. */
  const reload = useCallback(async () => {
    const result = client.graphTopology();
    const next = await Promise.resolve(result);
    setTopology(next);
  }, [client]);

  useEffect(() => {
    void reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = client.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 600);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [client, reload]);

  const settings: GraphSettings = useMemo(
    () => ({
      showClasses: prefs.showClasses,
      showJournal: prefs.showJournal,
      families: { ...prefs.families },
      semanticTopK: prefs.semanticTopK,
      semanticMinWeight: prefs.semanticMinWeight,
    }),
    [prefs],
  );

  const display = useMemo(
    () => (topology === null ? null : applyGraphSettings(topology, settings, scope)),
    [topology, settings, scope],
  );

  const counts = display === null ? null : graphCounts(display);

  // Keep the loop mirrors current without re-running the GL lifecycle.
  useEffect(() => {
    loopStateRef.current.paused = prefs.paused;
  }, [prefs.paused]);
  useEffect(() => {
    nodeSizeRef.current = prefs.nodeSize;
  }, [prefs.nodeSize]);
  useEffect(() => {
    presetRef.current = prefs.preset;
  }, [prefs.preset]);
  useEffect(() => {
    loopStateRef.current.selected = selected;
    rendererRef.current?.setSelectedNode(selected ?? "");
  }, [selected]);
  useEffect(() => {
    loopStateRef.current.hovered = hover !== null && hover.kind === "node" ? hover.id : null;
  }, [hover]);

  // Live physics tuning — no GL rebuild.
  useEffect(() => {
    engineRef.current?.setConfig({
      preset: prefs.preset,
      centralGravity: 30,
      linkCountAttraction: prefs.nodeSize === "connections",
      clustering: true,
    });
  }, [prefs.preset, prefs.nodeSize]);

  // ── Engine + renderer lifecycle (rebuilds only on the display set) ─────────
  useEffect(() => {
    if (display === null) return;
    const canvas = canvasRef.current;
    const labelCanvas = labelCanvasRef.current;
    const container = containerRef.current;
    if (canvas === null || labelCanvas === null || container === null) return;

    const renderer = new GraphWebGLRenderer({ defaultRadius: 8, edgeWidth: 0.8, cullMargin: 150 });
    try {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(container.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(container.clientHeight * dpr));
      labelCanvas.width = canvas.width;
      labelCanvas.height = canvas.height;
      renderer.init(canvas);
    } catch (error) {
      setGlError(error instanceof Error ? error.message : String(error));
      return;
    }
    rendererRef.current = renderer;
    setGlError(null);

    const theme = graphTheme();
    const cached = loadCachedPositions(client.getWorkspaceId());

    const degrees = new Map<string, number>();
    for (const edge of display.edges) {
      degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
    }
    const maxDegree = Math.max(1, ...degrees.values());

    const engineNodes = display.nodes.map((node) => {
      const degree = degrees.get(node.id) ?? 0;
      const radius =
        nodeSizeRef.current === "connections" ? 8 * (1 + (degree / maxDegree) * 0.6) : 8;
      const color = node.color !== null ? hexToRgba(resolveCssColor(node.color)) : undefined;
      const cachedPos = cached.get(node.id);
      return {
        nodeUuid: node.id,
        x: cachedPos?.x,
        y: cachedPos?.y,
        connectionCount: degree,
        radius,
        color,
        pinned: cachedPos !== undefined,
        isClass: node.isClass,
      };
    });
    const idRadius = new Map<string, number>();
    const visuals = new Map<string, { radius: number; color?: Float32Array }>();
    for (const node of engineNodes) {
      idRadius.set(node.nodeUuid, node.radius);
      visuals.set(node.nodeUuid, {
        radius: node.radius,
        ...(node.color !== undefined ? { color: new Float32Array(node.color) } : {}),
      });
    }
    renderer.setNodeVisuals(
      engineNodes.map((n) => n.nodeUuid),
      visuals,
    );

    const engineEdges = display.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.kind,
      weight: edge.weight,
    }));
    const renderEdges: RendererEdge[] = display.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      linkType: LINK_TYPE_IDS[edge.kind],
      ...(edge.kind === "semantic"
        ? { width: 0.7 + Math.min(2.1, edge.weight * 0.3) }
        : {}),
      color:
        edge.kind === "semantic"
          ? ([...theme.semanticEdge, 0.55] as [number, number, number, number])
          : ([...theme.edgeDefault, 0.5] as [number, number, number, number]),
    }));
    renderer.setEdges(renderEdges);

    const engine = new EngineController((frame) => {
      frameRef.current = frame;
      dirtyRef.current = true;
    });
    engineRef.current = engine;
    engine.init(
      engineNodes.map(({ nodeUuid, x, y, connectionCount, pinned }) => ({
        nodeUuid,
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        connectionCount,
        pinned,
      })),
      engineEdges,
      {
        preset: presetRef.current,
        centralGravity: 30,
        linkCountAttraction: nodeSizeRef.current === "connections",
        clustering: true,
      },
    );

    const resizeObserver = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(container.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(container.clientHeight * dpr));
      labelCanvas.width = canvas.width;
      labelCanvas.height = canvas.height;
      renderer.resize(canvas.width, canvas.height);
    });
    resizeObserver.observe(container);

    let raf = 0;
    let frames = 0;
    let fpsWindowStart = performance.now();
    let lastSave = performance.now();
    const namesCache = new Map<string, string>();
    const nameOf = (id: string): string => {
      let name = namesCache.get(id);
      if (name === undefined) {
        name = client.getDisplayName(id) ?? id;
        namesCache.set(id, name);
      }
      return name;
    };

    const loop = (): void => {
      raf = requestAnimationFrame(loop);
      const frame = frameRef.current;
      if (frame !== null && dirtyRef.current) {
        dirtyRef.current = false;
        renderer.updatePositions(frame.positions, frame.nodeIds);
      }
      if (engine.runsOnMainThread && !loopStateRef.current.paused) engine.step();
      const cam = cameraRef.current;
      renderer.setCamera(cam.x, cam.y, cam.zoom);
      renderer.setEdgeMask(edgeMaskForZoom(cam.zoom));
      renderer.render();

      const lctx = labelCanvas.getContext("2d");
      if (lctx !== null) {
        // Names refresh on a slow cadence — renames converge without
        // rebuilding the map (8.5k derivations) every frame.
        if (frames % 60 === 0) namesCache.clear();
        const labelFrame: LabelFrame = {
          ctx: lctx,
          width: labelCanvas.width,
          height: labelCanvas.height,
          dpr: window.devicePixelRatio || 1,
          zoom: cam.zoom,
          positions: renderer.nodePositions,
          order: renderer.nodeOrder,
          names: new Map(renderer.nodeOrder.map((id) => [id, nameOf(id)])),
          radii: idRadius,
          worldToScreen: (wx, wy) => renderer.worldToScreen(wx, wy),
          baseNodeRadius: 8,
          hovered: loopStateRef.current.hovered ?? loopStateRef.current.selected,
          selected: loopStateRef.current.selected,
          colors: graphTheme(),
        };
        drawLabels(labelFrame);
      }

      frames += 1;
      const now = performance.now();
      if (now - fpsWindowStart >= 1000) {
        setFps(Math.round((frames * 1000) / (now - fpsWindowStart)));
        frames = 0;
        fpsWindowStart = now;
      }
      if (now - lastSave > 5000 && frame !== null) {
        lastSave = now;
        cachePositions(client.getWorkspaceId(), frame.nodeIds, frame.positions);
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      if (frameRef.current !== null) {
        cachePositions(client.getWorkspaceId(), frameRef.current.nodeIds, frameRef.current.positions);
      }
      engine.dispose();
      engineRef.current = null;
      renderer.destroy();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, client]);

  // ── Interactions ───────────────────────────────────────────────────────────
  const worldAt = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (canvas === null || renderer === null) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return renderer.screenToWorld(
      (event.clientX - rect.left) * dpr,
      (event.clientY - rect.top) * dpr,
    );
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const renderer = rendererRef.current;
    const engine = engineRef.current;
    if (renderer === null || engine === null) return;
    const world = worldAt(event);
    const nodeId = renderer.pickNode(world.x, world.y, 24 / cameraRef.current.zoom);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (nodeId !== null) {
      draggingRef.current = { nodeId };
      engine.dragStart(nodeId);
      engine.dragMove(nodeId, world.x, world.y);
    } else {
      panRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        camX: cameraRef.current.x,
        camY: cameraRef.current.y,
      };
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const renderer = rendererRef.current;
    if (renderer === null) return;
    const engine = engineRef.current;
    const world = worldAt(event);
    if (draggingRef.current !== null && engine !== null) {
      engine.dragMove(draggingRef.current.nodeId, world.x, world.y);
      return;
    }
    if (panRef.current !== null) {
      const dpr = window.devicePixelRatio || 1;
      cameraRef.current.x = panRef.current.camX - (event.clientX - panRef.current.startX) * dpr / cameraRef.current.zoom;
      cameraRef.current.y = panRef.current.camY + (event.clientY - panRef.current.startY) * dpr / cameraRef.current.zoom;
      return;
    }
    const nodeId = renderer.pickNode(world.x, world.y, 24 / cameraRef.current.zoom);
    const rect = event.currentTarget.getBoundingClientRect();
    const tip = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (nodeId !== null) {
      setHover({ kind: "node", id: nodeId, ...tip });
      renderer.setHoveredNode(nodeId);
      return;
    }
    const edgeIndex = display === null ? -1 : renderer.pickEdge(world.x, world.y, 10 / cameraRef.current.zoom);
    if (display !== null && edgeIndex >= 0) {
      const edge = display.edges[edgeIndex];
      if (edge !== undefined) {
        setHover({ kind: "edge", edge, ...tip });
        renderer.setHoveredEdge(edgeIndex);
        return;
      }
    }
    setHover(null);
    renderer.setHoveredNode("");
    renderer.setHoveredEdge(-1);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const engine = engineRef.current;
    if (draggingRef.current !== null && engine !== null) {
      const dragged = draggingRef.current.nodeId;
      engine.dragEnd(dragged);
      draggingRef.current = null;
      const world = worldAt(event);
      const still = rendererRef.current?.pickNode(world.x, world.y, 24 / cameraRef.current.zoom);
      if (still === dragged) setSelected(dragged);
      return;
    }
    panRef.current = null;
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (renderer === null || canvas === null) return;
    const cam = cameraRef.current;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextZoom = Math.min(8, Math.max(0.05, cam.zoom * factor));
    const rect = event.currentTarget.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const px = (event.clientX - rect.left) * dpr;
    const py = (event.clientY - rect.top) * dpr;
    const world = renderer.screenToWorld(px, py);
    cam.x = world.x - (px - canvas.width / 2) / nextZoom;
    cam.y = world.y + (py - canvas.height / 2) / nextZoom;
    cam.zoom = nextZoom;
  };

  const recenter = (): void => {
    const renderer = rendererRef.current;
    if (renderer === null) return;
    cameraRef.current = renderer.fitToCanvas();
  };

  const jumpToSearch = (): void => {
    if (display === null || search.trim() === "") return;
    const needle = search.trim().toLowerCase();
    const hit = display.nodes.find((node) =>
      (client.getDisplayName(node.id) ?? node.id).toLowerCase().includes(needle),
    );
    if (hit === undefined) return;
    setSelected(hit.id);
    rendererRef.current?.setSelectedNode(hit.id);
    const frame = frameRef.current;
    if (frame === null) return;
    const idx = frame.nodeIds.indexOf(hit.id);
    if (idx < 0) return;
    cameraRef.current = { x: frame.positions[idx * 2]!, y: frame.positions[idx * 2 + 1]!, zoom: 1 };
  };

  const openSelected = (): void => {
    if (selected !== null) onNodeClick?.(selected);
  };

  const patch = (partial: Partial<GraphPrefs>): void =>
    setPrefs((prev) => ({ ...prev, ...partial }));

  // ── Render ─────────────────────────────────────────────────────────────────
  if (display === null || counts === null) {
    return (
      <div className="nt-graph nt-graph--loading">
        <EmptyState title="Loading graph…" description="Projecting the workspace topology." />
      </div>
    );
  }

  if (glError !== null) {
    return (
      <div className="nt-graph nt-graph--error">
        <EmptyState
          title="WebGL 2 required"
          description={`The graph view needs a WebGL 2 capable browser. (${glError})`}
        />
      </div>
    );
  }

  return (
    <div className="nt-graph">
      <div className="nt-graph__toolbar" role="toolbar" aria-label="Graph settings">
        <button type="button" className="nt-graph__tool" onClick={recenter} title="Recenter">
          <Icon path="mdi-image-filter-center-focus" size={0.8} />
        </button>
        <button
          type="button"
          className={`nt-graph__tool${prefs.paused ? " nt-graph__tool--on" : ""}`}
          onClick={() => patch({ paused: !prefs.paused })}
          title={prefs.paused ? "Resume layout" : "Pause layout"}
          aria-pressed={prefs.paused}
        >
          <Icon path={prefs.paused ? "mdi-play" : "mdi-pause"} size={0.8} />
        </button>
        <select
          className="nt-graph__select"
          aria-label="Physics preset"
          value={prefs.preset}
          onChange={(event) => patch({ preset: event.target.value as PhysicsPreset })}
        >
          <option value="sparse">Sparse</option>
          <option value="balanced">Balanced</option>
          <option value="compact">Compact</option>
          <option value="clustered">Clustered</option>
        </select>
        <button
          type="button"
          className={`nt-graph__tool${prefs.nodeSize === "connections" ? " nt-graph__tool--on" : ""}`}
          onClick={() =>
            patch({ nodeSize: prefs.nodeSize === "connections" ? "uniform" : "connections" })
          }
          title="Size nodes by connections"
          aria-pressed={prefs.nodeSize === "connections"}
        >
          <Icon path="mdi-chart-bubble" size={0.8} />
        </button>
        <span className="nt-graph__sep" aria-hidden="true" />
        {FAMILY_LABELS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`nt-graph__chip${prefs.families[key] === true ? " nt-graph__chip--on" : ""}`}
            aria-pressed={prefs.families[key] === true}
            onClick={() => patch({ families: { ...prefs.families, [key]: !prefs.families[key] } })}
          >
            {label}
          </button>
        ))}
        <span className="nt-graph__sep" aria-hidden="true" />
        <label className="nt-graph__toggle">
          <input
            type="checkbox"
            checked={prefs.showClasses}
            onChange={(event) => patch({ showClasses: event.target.checked })}
          />
          Class nodes
        </label>
        <label className="nt-graph__toggle">
          <input
            type="checkbox"
            checked={prefs.showJournal}
            onChange={(event) => patch({ showJournal: event.target.checked })}
          />
          Journal
        </label>
        <span className="nt-graph__counts" aria-live="polite">
          {counts.nodes} nodes · {counts.edges} edges
        </span>
        <span className="nt-graph__toolbar-spacer" />
        <input
          type="search"
          className="nt-graph__search"
          placeholder="Find node…"
          aria-label="Find node"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") jumpToSearch();
            if (event.key === "Escape") setSearch("");
          }}
        />
      </div>
      <div className="nt-graph__stage" ref={containerRef}>
        <canvas
          ref={canvasRef}
          className="nt-graph__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={() => openSelected()}
        />
        <canvas ref={labelCanvasRef} className="nt-graph__labels" aria-hidden="true" />
        {hover !== null && (
          <div
            className="nt-graph__tooltip"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
            role="tooltip"
          >
            {hover.kind === "node" ? (
              <>
                <div className="nt-graph__tooltip-title">
                  {client.getDisplayName(hover.id) ?? hover.id}
                </div>
                <div className="nt-graph__tooltip-hint">
                  Click to select · double-click to open
                </div>
              </>
            ) : (
              <>
                <div className="nt-graph__tooltip-title">
                  {hover.edge.kind === "semantic" ? "Semantic link" : `${hover.edge.kind} link`}
                  {hover.edge.weight > 1 ? ` · ×${hover.edge.weight}` : ""}
                </div>
                <div className="nt-graph__tooltip-hint">
                  {client.getDisplayName(hover.edge.source) ?? hover.edge.source} ↔{" "}
                  {client.getDisplayName(hover.edge.target) ?? hover.edge.target}
                </div>
                {hover.edge.evidence !== null && hover.edge.evidence.length > 0 && (
                  <div className="nt-graph__tooltip-evidence">
                    Co-mentioned in:{" "}
                    {hover.edge.evidence
                      .slice(0, 3)
                      .map((id) => client.getDisplayName(id) ?? id)
                      .join(" · ")}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {selected !== null && (
          <div className="nt-graph__selection-bar">
            <span className="nt-graph__selection-name">
              {client.getDisplayName(selected) ?? selected}
            </span>
            <button type="button" className="nt-graph__chip" onClick={openSelected}>
              Open
            </button>
            <button type="button" className="nt-graph__chip" onClick={() => setSelected(null)}>
              Clear
            </button>
          </div>
        )}
      </div>
      {prefs.families.semantic === true && (
        <div className="nt-graph__semantic-panel">
          <label className="nt-graph__semantic-slider">
            <span>Semantic detail (top-{prefs.semanticTopK} per node)</span>
            <Slider
              min={1}
              max={12}
              step={1}
              value={prefs.semanticTopK}
              onChange={(value) => patch({ semanticTopK: value })}
              aria-label="Semantic edges per node"
            />
          </label>
          <label className="nt-graph__semantic-slider">
            <span>Minimum weight ({prefs.semanticMinWeight})</span>
            <Slider
              min={1}
              max={5}
              step={1}
              value={prefs.semanticMinWeight}
              onChange={(value) => patch({ semanticMinWeight: value })}
              aria-label="Semantic minimum weight"
            />
          </label>
        </div>
      )}
    </div>
  );
}

registerView({
  id: "graph",
  label: "Graph",
  icon: "mdi-graph-outline",
  component: GraphView,
  capabilities: {},
});
