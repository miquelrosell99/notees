/**
 * GraphView — the workspace graph: every page and class
 * as a node, every rolled-up link as an edge,
 * force-directed in a worker (or on a fixed radial layout), drawn by the
 * WebGL2 renderer with a Canvas 2D label overlay and a minimap.
 *
 * Owner rulings baked in: blocks NEVER render as nodes (they surface only as
 * edge evidence); the journal chain is in the topology but filtered off by
 * default; the semantic (co-occurrence) and temporal (same-day) families
 * render weighted, sparsified, and toggleable alongside the structural
 * families; orphan filtering, QueryAST color groups, the circle/tree layout
 * modes, and per-surface settings persistence ride the same toolbar.
 *
 * `local` scopes the topology to a node's neighborhood (the right-rail card);
 * `items` scopes it to a node collection (the registry mode).
 *
 * The chrome follows the reference graph UI: the settings toolbar's icon
 * tools, mode selectors, and visibility toggles compose from the kit (the
 * ghost-button tool idiom, the icon-radio mode selector, the boolean
 * switch), the edge-family chips stay the rendering register, and the empty
 * surfaces carry the reference wording — "Nothing to graph yet" for the
 * empty workspace, the levels hint for an empty neighborhood, and the
 * filtered-out state with its reset affordance on the full surface. The
 * engine/renderer machinery (WebGL draw, physics, minimap, local mode,
 * settings persistence) is unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GraphEdge, GraphEdgeKind, GraphTopology } from "@notees/store";

import type { NodeCollectionProps } from "../types.js";
import { registerView } from "../registry.js";
import {
  BooleanToggle,
  Button,
  ColorButton,
  EmptyState,
  SearchField,
  SelectionButton,
  Slider,
} from "../../components/ui/index.js";
import { usePopupDismissal } from "../../components/ui/usePopupDismissal.js";
import { resolveCssColor } from "../../components/ui/colorPresets.js";
import { readDeviceSetting, writeDeviceSetting } from "../../components/modals/deviceSettings.js";

import {
  DEFAULT_GRAPH_SETTINGS,
  LINK_TYPE_IDS,
  applyGraphSettings,
  edgeMaskForZoom,
  graphCounts,
  type GraphSettings,
} from "./filter.js";
import { computeFixedLayout, type GraphLayoutMode } from "./layouts.js";
import { colorGroupError, evaluateColorGroups, type GraphColorGroup } from "./colorGroups.js";
import { EngineController, type EngineFrame } from "./engineController.js";
import { GraphWebGLRenderer, type RendererEdge } from "./renderer/webglRenderer.js";
import { drawLabels, type LabelFrame } from "./renderer/labelCanvas.js";
import { graphTheme } from "./renderer/theme.js";
import { GraphMinimap } from "./minimap.js";
import "./GraphView.css";

type PhysicsPreset = "sparse" | "balanced" | "compact" | "clustered";
type NodeSizeMode = "uniform" | "connections";

interface GraphPrefs {
  showClasses: boolean;
  showJournal: boolean;
  showOrphans: boolean;
  families: Record<GraphEdgeKind, boolean>;
  semanticTopK: number;
  semanticMinWeight: number;
  preset: PhysicsPreset;
  nodeSize: NodeSizeMode;
  paused: boolean;
  layoutMode: GraphLayoutMode;
  colorGroupsOn: boolean;
  colorGroups: GraphColorGroup[];
}

const FAMILY_LABELS: Array<{ key: GraphEdgeKind; label: string }> = [
  { key: "mention", label: "Mentions" },
  { key: "property", label: "Properties" },
  { key: "parent", label: "Parents" },
  { key: "class", label: "Classes" },
  { key: "semantic", label: "Semantic" },
  { key: "temporal", label: "Temporal" },
];

const POSITIONS_KEY = (workspaceId: string): string => `notees.graph.positions.${workspaceId}`;
const PREFS_KEY = (surface: string): string => `graphPrefs.${surface}`;

function defaultPrefs(): GraphPrefs {
  return {
    ...DEFAULT_GRAPH_SETTINGS,
    preset: "balanced",
    nodeSize: "uniform",
    paused:
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    layoutMode: "force",
    colorGroupsOn: false,
    colorGroups: [],
  };
}

/** Stored prefs merge over the defaults so new family keys appear. */
function loadPrefs(surface: string): GraphPrefs {
  const stored = readDeviceSetting<Partial<GraphPrefs> | null>(PREFS_KEY(surface), null);
  const base = defaultPrefs();
  if (stored === null) return base;
  return {
    ...base,
    ...stored,
    families: { ...base.families, ...(stored.families ?? {}) },
    colorGroups: Array.isArray(stored.colorGroups) ? stored.colorGroups : [],
  };
}

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

export function GraphView({ client, items, onNodeClick, local }: NodeCollectionProps & {
  /** Neighborhood scope (the right-rail local-graph card). */
  local?: { anchorId: string; depth: number; onDepthChange?: ((depth: number) => void) | undefined } | undefined;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<GraphWebGLRenderer | null>(null);
  const engineRef = useRef<EngineController | null>(null);
  const cameraRef = useRef({ x: 0, y: 0, zoom: 0.5 });
  const frameRef = useRef<EngineFrame | null>(null);
  const dirtyRef = useRef(false);
  const draggingRef = useRef<{ nodeId: string } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; camX: number; camY: number } | null>(null);
  const prefsSurface = local !== undefined ? "local" : "full";

  // Loop-visible mirrors — hover/selection/prefs must NOT rebuild the GL stack.
  const loopStateRef = useRef<{ hovered: string | null; selected: string | null; paused: boolean }>({
    hovered: null,
    selected: null,
    paused: false,
  });
  const nodeSizeRef = useRef<NodeSizeMode>("uniform");
  const presetRef = useRef<PhysicsPreset>("balanced");
  const layoutModeRef = useRef<GraphLayoutMode>("force");

  const [topology, setTopology] = useState<GraphTopology | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<GraphPrefs>(() => loadPrefs(prefsSurface));
  const [groupsOpen, setGroupsOpen] = useState(false);
  const groupsPanelRef = useRef<HTMLDivElement | null>(null);
  const groupsButtonRef = useRef<HTMLButtonElement | null>(null);
  usePopupDismissal({
    popupRef: groupsPanelRef,
    anchorRefs: [groupsButtonRef],
    isOpen: groupsOpen,
    onClose: () => setGroupsOpen(false),
  });
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

  const anchorId = local?.anchorId;
  const depth = local?.depth;

  /** Load (or reload) the topology; debounced caller on subscribe below. */
  const reload = useCallback(async () => {
    const result =
      anchorId !== undefined
        ? client.graphTopology({ anchor: anchorId, depth: depth ?? 2 })
        : client.graphTopology();
    const next = await Promise.resolve(result);
    setTopology(next);
  }, [client, anchorId, depth]);

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

  // Settings persistence (device-local, never an op).
  useEffect(() => {
    const timer = setTimeout(() => {
      const { paused: _paused, ...persisted } = prefs;
      writeDeviceSetting(PREFS_KEY(prefsSurface), persisted);
    }, 400);
    return () => clearTimeout(timer);
  }, [prefs, prefsSurface]);

  const settings: GraphSettings = useMemo(
    () => ({
      showClasses: prefs.showClasses,
      showJournal: prefs.showJournal,
      showOrphans: prefs.showOrphans,
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
    layoutModeRef.current = prefs.layoutMode;
  }, [prefs.layoutMode]);
  useEffect(() => {
    loopStateRef.current.selected = selected;
    rendererRef.current?.setSelectedNode(selected ?? "");
  }, [selected]);
  useEffect(() => {
    loopStateRef.current.hovered = hover !== null && hover.kind === "node" ? hover.id : null;
  }, [hover]);

  // Live physics tuning — no GL rebuild (force layout only).
  useEffect(() => {
    if (prefs.layoutMode !== "force") return;
    engineRef.current?.setConfig({
      preset: prefs.preset,
      centralGravity: 30,
      linkCountAttraction: prefs.nodeSize === "connections",
      clustering: true,
    });
  }, [prefs.preset, prefs.nodeSize, prefs.layoutMode]);

  // Color groups evaluation (first match wins; the node's own color rides
  // underneath — group colors only paint when the toggle is on). Async —
  // the worker client's query runner is async.
  const [groupColors, setGroupColors] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!prefs.colorGroupsOn || prefs.colorGroups.length === 0) {
      setGroupColors(new Map());
      return;
    }
    let cancelled = false;
    void evaluateColorGroups(client, prefs.colorGroups, resolveCssColor).then((colors) => {
      if (!cancelled) setGroupColors(colors);
    });
    return () => {
      cancelled = true;
    };
  }, [client, prefs.colorGroupsOn, prefs.colorGroups]);

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

    const fixedLayout =
      layoutModeRef.current === "force" ? null : computeFixedLayout(layoutModeRef.current, display);

    const engineNodes = display.nodes.map((node) => {
      const degree = degrees.get(node.id) ?? 0;
      const radius =
        nodeSizeRef.current === "connections" ? 8 * (1 + (degree / maxDegree) * 0.6) : 8;
      const grouped = groupColors.get(node.id);
      const color =
        grouped !== undefined
          ? hexToRgba(grouped)
          : node.color !== null
            ? hexToRgba(resolveCssColor(node.color))
            : undefined;
      const cachedPos = cached.get(node.id);
      const fixed = fixedLayout?.get(node.id);
      const start = fixed ?? cachedPos;
      return {
        nodeUuid: node.id,
        x: start?.x,
        y: start?.y,
        connectionCount: degree,
        radius,
        color,
        pinned: fixed !== undefined || cachedPos !== undefined,
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
      ...(edge.kind === "semantic" || edge.kind === "temporal"
        ? { width: 0.7 + Math.min(2.1, edge.weight * 0.3) }
        : {}),
      color:
        edge.kind === "semantic" || edge.kind === "temporal"
          ? ([...theme.semanticEdge, 0.55] as [number, number, number, number])
          : ([...theme.edgeDefault, 0.5] as [number, number, number, number]),
    }));
    renderer.setEdges(renderEdges);

    if (fixedLayout === null) {
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
    } else {
      // Fixed radial layout: the computed positions ARE the frame — no
      // engine, physics chrome hidden, drag overrides the renderer only.
      const order = engineNodes.map((n) => n.nodeUuid);
      const positions = new Float32Array(order.length * 2);
      for (let i = 0; i < order.length; i++) {
        const p = fixedLayout.get(order[i]!) ?? { x: 0, y: 0 };
        positions[i * 2] = p.x;
        positions[i * 2 + 1] = p.y;
      }
      frameRef.current = { positions, nodeIds: order, nodeCount: order.length, energy: 0, ticks: 0 };
      dirtyRef.current = true;
      engineRef.current = null;
      const fit = renderer.fitToCanvas();
      cameraRef.current = fit;
    }

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
      const engine = engineRef.current;
      if (engine !== null && engine.runsOnMainThread && !loopStateRef.current.paused) {
        engine.step();
      }
      const cam = cameraRef.current;
      renderer.setCamera(cam.x, cam.y, cam.zoom);
      renderer.setEdgeMask(edgeMaskForZoom(cam.zoom));
      renderer.render();

      const lctx = labelCanvas.getContext("2d");
      if (lctx !== null) {
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

      const minimap = minimapCanvasRef.current;
      if (minimap !== null) {
        const mctx = minimap.getContext("2d");
        if (mctx !== null) {
          GraphMinimap.draw(
            mctx,
            minimap.width,
            minimap.height,
            renderer.nodePositions,
            renderer.nodeOrder,
            cam,
            canvas.width,
            canvas.height,
          );
        }
      }

      frames += 1;
      const now = performance.now();
      if (now - fpsWindowStart >= 1000) {
        setFps(Math.round((frames * 1000) / (now - fpsWindowStart)));
        frames = 0;
        fpsWindowStart = now;
      }
      if (now - lastSave > 5000 && frame !== null && engineRef.current !== null) {
        lastSave = now;
        cachePositions(client.getWorkspaceId(), frame.nodeIds, frame.positions);
      }
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      if (frameRef.current !== null && engineRef.current !== null) {
        cachePositions(client.getWorkspaceId(), frameRef.current.nodeIds, frameRef.current.positions);
      }
      engineRef.current?.dispose();
      engineRef.current = null;
      renderer.destroy();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, client, groupColors]);

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
    if (renderer === null) return;
    const world = worldAt(event);
    const nodeId = renderer.pickNode(world.x, world.y, 24 / cameraRef.current.zoom);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (nodeId !== null) {
      draggingRef.current = { nodeId };
      engine?.dragStart(nodeId);
      engine?.dragMove(nodeId, world.x, world.y);
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
    if (draggingRef.current !== null) {
      if (engine !== null) {
        engine.dragMove(draggingRef.current.nodeId, world.x, world.y);
      } else {
        // Fixed layout: drag rides the renderer's position override only.
        renderer.overridePosition(draggingRef.current.nodeId, world.x, world.y);
        const frame = frameRef.current;
        if (frame !== null) {
          const idx = frame.nodeIds.indexOf(draggingRef.current.nodeId);
          if (idx >= 0) {
            frame.positions[idx * 2] = world.x;
            frame.positions[idx * 2 + 1] = world.y;
            dirtyRef.current = true;
          }
        }
      }
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
    if (draggingRef.current !== null) {
      const dragged = draggingRef.current.nodeId;
      engine?.dragEnd(dragged);
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

  const onMinimapNavigate = (worldX: number, worldY: number): void => {
    cameraRef.current = { ...cameraRef.current, x: worldX, y: worldY };
  };

  const openSelected = (): void => {
    if (selected !== null) onNodeClick?.(selected);
  };

  const patch = (partial: Partial<GraphPrefs>): void =>
    setPrefs((prev) => ({ ...prev, ...partial }));

  /**
   * The filtered-out empty state's reset affordance: back to the shipped
   * defaults (every family on, classes and orphans visible, the journal
   * chain off). Scoped collections (the registry mode) offer no reset — the
   * scope is the collection, not a user-toggled filter.
   */
  const resetFilters = (): void =>
    patch({
      showClasses: DEFAULT_GRAPH_SETTINGS.showClasses,
      showJournal: DEFAULT_GRAPH_SETTINGS.showJournal,
      showOrphans: DEFAULT_GRAPH_SETTINGS.showOrphans,
      families: { ...DEFAULT_GRAPH_SETTINGS.families },
    });

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

  const semanticPanelVisible =
    (prefs.families.semantic === true || prefs.families.temporal === true) &&
    local === undefined;

  /**
   * The reference empty surfaces: an empty workspace (the full surface
   * only — a local neighborhood always has its anchor), an empty
   * neighborhood (names the depth), and everything-filtered-out on the
   * full surface (carries the reset). An empty display renders INSTEAD of
   * the stage: no canvas mounts, so no renderer initializes on a graph
   * with nothing to draw.
   */
  const graphEmpty = display.nodes.length === 0;
  const nothingToGraph = local === undefined && topology !== null && topology.nodes.length === 0;

  return (
    <div className="nt-graph">
      <div className="nt-graph__toolbar" role="toolbar" aria-label="Graph settings">
        <Button
          variant="ghost"
          size="sm"
          icon="mdi mdi-image-filter-center-focus"
          aria-label="Recenter"
          title="Recenter"
          onClick={recenter}
        />
        {prefs.layoutMode === "force" && (
          <Button
            variant="ghost"
            size="sm"
            icon={prefs.paused ? "mdi mdi-play" : "mdi mdi-pause"}
            active={prefs.paused}
            aria-pressed={prefs.paused}
            aria-label={prefs.paused ? "Resume layout" : "Pause layout"}
            title={prefs.paused ? "Resume layout" : "Pause layout"}
            onClick={() => patch({ paused: !prefs.paused })}
          />
        )}
        <SelectionButton
          size="sm"
          options={[
            { value: "force", icon: "mdi mdi-atom", label: "Force" },
            { value: "circle", icon: "mdi mdi-circle-outline", label: "Circle" },
            { value: "tree", icon: "mdi mdi-file-tree-outline", label: "Tree" },
          ]}
          value={prefs.layoutMode}
          onChange={(value) => patch({ layoutMode: value as GraphLayoutMode })}
        />
        {prefs.layoutMode === "force" && (
          <SelectionButton
            size="sm"
            options={[
              { value: "sparse", icon: "mdi mdi-arrow-expand", label: "Sparse" },
              { value: "balanced", icon: "mdi mdi-scale-balance", label: "Balanced" },
              { value: "compact", icon: "mdi mdi-arrow-collapse", label: "Compact" },
              { value: "clustered", icon: "mdi mdi-group", label: "Clustered" },
            ]}
            value={prefs.preset}
            onChange={(value) => patch({ preset: value as PhysicsPreset })}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          icon="mdi mdi-chart-bubble"
          active={prefs.nodeSize === "connections"}
          aria-pressed={prefs.nodeSize === "connections"}
          aria-label="Size nodes by connections"
          title="Size nodes by connections"
          onClick={() =>
            patch({ nodeSize: prefs.nodeSize === "connections" ? "uniform" : "connections" })
          }
        />
        {local === undefined && (
          <>
            <span className="nt-graph__sep" aria-hidden="true" />
            {FAMILY_LABELS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`nt-graph__chip${prefs.families[key] === true ? " nt-graph__chip--on" : ""}`}
                aria-pressed={prefs.families[key] === true}
                onClick={() =>
                  patch({ families: { ...prefs.families, [key]: !prefs.families[key] } })
                }
              >
                {label}
              </button>
            ))}
            <span className="nt-graph__sep" aria-hidden="true" />
            <BooleanToggle
              size="sm"
              label="Class nodes"
              labelPosition="left"
              checked={prefs.showClasses}
              onChange={(event) => patch({ showClasses: event.target.checked })}
            />
            <BooleanToggle
              size="sm"
              label="Journal"
              labelPosition="left"
              checked={prefs.showJournal}
              onChange={(event) => patch({ showJournal: event.target.checked })}
            />
            <BooleanToggle
              size="sm"
              label="Orphans"
              labelPosition="left"
              checked={prefs.showOrphans}
              onChange={(event) => patch({ showOrphans: event.target.checked })}
            />
          </>
        )}
        {local !== undefined && (
          <label className="nt-graph__depth">
            Depth
            <Slider
              min={1}
              max={3}
              step={1}
              value={local.depth}
              onChange={(value) => local.onDepthChange?.(value)}
              aria-label="Neighborhood depth"
            />
            <span className="nt-graph__depth-value" aria-hidden="true">
              {local.depth}
            </span>
          </label>
        )}
        <span className="nt-graph__counts" aria-live="polite">
          {counts.nodes} nodes · {counts.edges} edges
        </span>
        {local === undefined && (
          <>
            <span className="nt-graph__toolbar-spacer" />
            <button
              ref={groupsButtonRef}
              type="button"
              className={`nt-graph__chip${prefs.colorGroupsOn ? " nt-graph__chip--on" : ""}`}
              aria-pressed={prefs.colorGroupsOn}
              onClick={() => setGroupsOpen((open) => !open)}
            >
              Color groups
            </button>
            <SearchField
              className="nt-graph__search-field"
              aria-label="Find node"
              placeholder="Find node…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") jumpToSearch();
                if (event.key === "Escape") setSearch("");
              }}
            />
          </>
        )}
      </div>
      {nothingToGraph || graphEmpty ? (
        <div className="nt-graph__stage nt-graph__stage--empty">
          {nothingToGraph ? (
            <EmptyState
              title="Nothing to graph yet"
              description="Add pages and blocks to see how they connect."
            />
          ) : local !== undefined ? (
            <EmptyState
              title={`No connected nodes within ${local.depth} ${local.depth === 1 ? "level" : "levels"}`}
              description="Try increasing the levels to see more connections."
            />
          ) : (
            <EmptyState
              title="All nodes hidden by filters"
              description="Adjust visibility filters or reset them to see the graph."
              {...(scope === undefined
                ? { actionLabel: "Reset filters", onAction: resetFilters }
                : {})}
            />
          )}
        </div>
      ) : (
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
        {local === undefined && (
          <canvas
            ref={minimapCanvasRef}
            className="nt-graph__minimap"
            width={200}
            height={140}
            aria-label="Graph minimap"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const rect = event.currentTarget.getBoundingClientRect();
              const world = GraphMinimap.screenToWorld(
                ((event.clientX - rect.left) / rect.width) * event.currentTarget.width,
                ((event.clientY - rect.top) / rect.height) * event.currentTarget.height,
                event.currentTarget.width,
                event.currentTarget.height,
                frameRef.current,
                cameraRef.current,
              );
              onMinimapNavigate(world.x, world.y);
            }}
            onPointerMove={(event) => {
              if (event.buttons !== 1) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const world = GraphMinimap.screenToWorld(
                ((event.clientX - rect.left) / rect.width) * event.currentTarget.width,
                ((event.clientY - rect.top) / rect.height) * event.currentTarget.height,
                event.currentTarget.width,
                event.currentTarget.height,
                frameRef.current,
                cameraRef.current,
              );
              onMinimapNavigate(world.x, world.y);
            }}
          />
        )}
        {groupsOpen && local === undefined && (
          <div className="nt-graph__groups" ref={groupsPanelRef} role="dialog" aria-label="Color groups">
            <div className="nt-graph__groups-head">
              <strong>Color groups</strong>
              <label className="nt-graph__toggle">
                <input
                  type="checkbox"
                  checked={prefs.colorGroupsOn}
                  onChange={(event) => patch({ colorGroupsOn: event.target.checked })}
                />
                Paint groups
              </label>
            </div>
            <p className="nt-graph__groups-hint">
              Nodes matching a query paint in its color (first match wins).
            </p>
            {prefs.colorGroups.map((group) => {
              const error = colorGroupError(client, group.query);
              return (
                <div key={group.id} className="nt-graph__group-row">
                  <ColorButton
                    color={group.color}
                    size="xs"
                    showPicker
                    aria-label={`Color for ${group.label || "group"}`}
                    onColorChange={(color) =>
                      patch({
                        colorGroups: prefs.colorGroups.map((g) =>
                          g.id === group.id ? { ...g, color: color ?? "sky" } : g,
                        ),
                      })
                    }
                  />
                  <input
                    type="text"
                    className="nt-graph__group-label"
                    placeholder="Label"
                    defaultValue={group.label}
                    aria-label="Group label"
                    onBlur={(event) =>
                      patch({
                        colorGroups: prefs.colorGroups.map((g) =>
                          g.id === group.id ? { ...g, label: event.target.value } : g,
                        ),
                      })
                    }
                  />
                  <input
                    type="text"
                    className="nt-graph__group-query"
                    placeholder='class:book prop:read:""'
                    defaultValue={group.query}
                    aria-label="Group query"
                    onBlur={(event) =>
                      patch({
                        colorGroups: prefs.colorGroups.map((g) =>
                          g.id === group.id ? { ...g, query: event.target.value } : g,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="nt-graph__tool"
                    aria-label={`Remove ${group.label || "group"}`}
                    onClick={() =>
                      patch({ colorGroups: prefs.colorGroups.filter((g) => g.id !== group.id) })
                    }
                  >
                    ×
                  </button>
                  {error !== null && (
                    <p role="alert" className="nt-graph__group-error">
                      {error}
                    </p>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              className="nt-graph__chip"
              onClick={() =>
                patch({
                  colorGroups: [
                    ...prefs.colorGroups,
                    { id: crypto.randomUUID(), label: "", color: "sky", query: "" },
                  ],
                })
              }
            >
              + Add group
            </button>
          </div>
        )}
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
                  {hover.edge.kind === "semantic"
                    ? "Semantic link"
                    : hover.edge.kind === "temporal"
                      ? "Temporal link"
                      : `${hover.edge.kind} link`}
                  {hover.edge.weight > 1 ? ` · ×${hover.edge.weight}` : ""}
                </div>
                <div className="nt-graph__tooltip-hint">
                  {client.getDisplayName(hover.edge.source) ?? hover.edge.source} ↔{" "}
                  {client.getDisplayName(hover.edge.target) ?? hover.edge.target}
                </div>
                {hover.edge.evidence !== null && hover.edge.evidence.length > 0 && (
                  <div className="nt-graph__tooltip-evidence">
                    {hover.edge.kind === "temporal" ? "Also dated: " : "Co-mentioned in: "}
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
      )}
      {semanticPanelVisible && (
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
