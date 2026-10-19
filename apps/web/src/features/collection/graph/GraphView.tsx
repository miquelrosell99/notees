/**
 * GraphView — the workspace graph: every page and class
 * as a node, every rolled-up link as an edge,
 * force-directed in a worker (or on a fixed radial layout), drawn by the
 * PixiJS renderer with a Canvas 2D label overlay and a minimap.
 *
 * Owner rulings baked in: blocks NEVER render as nodes (they surface only as
 * edge evidence); the journal chain is in the topology but filtered off by
 * default (per-level: year/month/day); the semantic (co-occurrence) and
 * temporal (same-day) families render weighted, sparsified, and toggleable
 * alongside the structural families; orphan filtering, QueryAST color groups
 * (the ONLY painting mechanism — the retired class colors migrated into
 * groups), the circle/tree layout modes, and per-surface settings persistence
 * ride the same toolbar.
 *
 * `local` scopes the topology to a node's neighborhood (the right-rail card);
 * `items` scopes it to a node collection (the registry mode).
 *
 * The chrome composes from the kit (the ghost-button tool idiom, the
 * icon-radio mode selector, the boolean switch, the ButtonWithPanel popovers,
 * the Chip toggle pills, NodeViewSection collapsible sections, the Card
 * container, ListSortable drag-reorder, the Slider) and the edges own the
 * canvas: the bottom edge holds the control dock (recenter/pause/zoom/focus)
 * bottom-left, the mode bar + time-lapse strip bottom-center, the minimap
 * bottom-right; the right edge holds the curation rail (Selection + Colors)
 * — a flex sibling of the stage, so the drawable area excludes it and the
 * minimap hugs the remaining canvas. The interaction/navigation register
 * extends the v1 one:
 * drag empty space pans, the wheel zooms cursor-anchored (the minimap wheel
 * too), dragging a node rearranges it (instant local override + worker pin),
 * clicking a node toggles it in the multi-selection, double-click opens,
 * empty click clears — plus the keyboard surface (+/- zoom, arrows pan,
 * F focus, R recenter). Node hover highlights the neighborhood in the app's
 * accent color (Obsidian-style: the hovered node, its incident edges, and
 * its linked nodes accent; everything else stays visible but dimmed in its
 * own color) and the hovered node's label always renders, nudged a few
 * pixels down as the identifier — no tooltip box; edges keep the richer
 * kind/weight/evidence tooltip.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GraphEdge, GraphEdgeKind, GraphTopology } from "@notees/store";

import type { NodeCollectionProps } from "../types.js";
import { registerView } from "../registry.js";
import {
  BooleanToggle,
  Button,
  ButtonWithPanel,
  Card,
  Chip,
  ColorButton,
  Dropdown,
  EmptyState,
  ListSortable,
  LoadingScreen,
  SelectionButton,
  Slider,
  TextField,
} from "../../../components/ui/fleet/index.js";
import { resolveCssColor } from "../../../components/ui/fleet/colorPresets.js";
import { NodeSelector } from "../../pickers/NodeSelector.js";
import { NodeViewSection } from "../../page-sections/NodeViewSection.js";
import { FilterBlockBuilder } from "../FilterBlockBuilder.js";
import { readDeviceSetting, writeDeviceSetting } from "../../settings/deviceSettings.js";
import type { Group } from "@notees/query";

import {
  bboxForNodes,
  clampZoom,
  fitBoundingBoxCamera,
  panByScreenDelta,
  wheelZoomFactor,
  zoomAtCenter,
  zoomAtWorldPoint,
} from "./cameraMath.js";

import {
  DEFAULT_GRAPH_SETTINGS,
  LINK_TYPE_IDS,
  applyGraphSettings,
  edgeMaskForZoom,
  graphCounts,
  type GraphSettings,
} from "./filter.js";
import { computeFixedLayout, type GraphLayoutMode } from "./layouts.js";
import {
  evaluateColorGroups,
  isLegacyColorGroup,
  migrateColorGroup,
  type GraphColorGroup,
} from "./colorGroups.js";
import {
  computeNodeSizing,
  type LinkDirection,
  type NodeSizeMode,
} from "./nodeRadius.js";
import { buildNodeVisuals } from "./nodeVisuals.js";
import { EngineController, type EngineFrame } from "./engineController.js";
import { type RendererEdge } from "./renderer/edgePlan.js";
import { GraphPixiRenderer } from "./renderer/pixiRenderer.js";
import type { GraphRenderer } from "./renderer/graphRenderer.js";
import { drawLabels, labelSignatureChanged, type LabelDrawSignature, type LabelFrame } from "./renderer/labelCanvas.js";
import { graphTheme } from "./renderer/theme.js";
import { GraphMinimap } from "./minimap.js";
import "./GraphView.css";

type PhysicsPreset = "sparse" | "balanced" | "compact" | "clustered";

/** The RETIRED per-class color entry — kept as a local type because the
 *  persisted prefs shape still carries the (always-empty-since-migration)
 *  list so old device stores round-trip. */
interface RetiredClassColorEntry {
  classId: string;
  /** Preset token or #RRGGBB. */
  color: string;
}

interface GraphPrefs {
  showClasses: boolean;
  journalYear: boolean;
  journalMonth: boolean;
  journalDay: boolean;
  showSystemPages: boolean;
  showOrphans: boolean;
  families: Record<GraphEdgeKind, boolean>;
  semanticTopK: number;
  semanticMinWeight: number;
  /** Physics: more-connected nodes attract more strongly (v1's own toggle). */
  linkCountAttraction: boolean;
  /** Center gravity pulls components toward the middle (v1 toggle). */
  centralGravityOn: boolean;
  /** Mass accumulation: heavy parents resist movement (v1 toggle). */
  massAccumulation: boolean;
  /** Uniform-mode node radius (the v1 slider, 3–20). */
  baseNodeRadius: number;
  nodeSize: NodeSizeMode;
  linkDirection: LinkDirection;
  preset: PhysicsPreset;
  paused: boolean;
  layoutMode: GraphLayoutMode;
  /** Clustering: cohesion + soft-shell separation between communities. */
  clustering: boolean;
  /** Cluster separation slider (0–100) — scales the inter-cluster margin. */
  clusterSeparation: number;
  colorGroupsOn: boolean;
  colorGroups: GraphColorGroup[];
  /** The RETIRED per-class color list — retained in the persisted shape so
   *  old stores round-trip; the one-time load migration converts entries
   *  into query groups and clears this to []. Painting is groups-only. */
  classColors: RetiredClassColorEntry[];
  /** The right rail (full surface only): open/closed, persisted per device. */
  railOpen: boolean;
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
/** Time-lapse playback: min → max over ~20s, then rest. */
const TIME_LAPSE_DURATION_MS = 20_000;

function defaultPrefs(): GraphPrefs {
  return {
    ...DEFAULT_GRAPH_SETTINGS,
    linkCountAttraction: false,
    centralGravityOn: true,
    massAccumulation: true,
    baseNodeRadius: 8,
    nodeSize: "uniform",
    linkDirection: "all",
    preset: "balanced",
    paused:
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    layoutMode: "force",
    clustering: true,
    clusterSeparation: 65,
    colorGroupsOn: false,
    colorGroups: [],
    classColors: [],
    railOpen: false,
  };
}

/** Stored prefs merge over the defaults so new keys appear. The persisted
 *  color groups may still hold pre-AST legacy rows (text-DSL strings) — the
 *  type is the post-migration shape; the one-time migration effect rewrites
 *  them in place on mount. */
function loadPrefs(surface: string): GraphPrefs {
  const stored = readDeviceSetting<Partial<GraphPrefs> | null>(PREFS_KEY(surface), null);
  const base = defaultPrefs();
  if (stored === null) return base;
  return {
    ...base,
    ...stored,
    families: { ...base.families, ...(stored.families ?? {}) },
    colorGroups: Array.isArray(stored.colorGroups) ? stored.colorGroups : [],
    classColors: Array.isArray(stored.classColors) ? stored.classColors : [],
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
  // Typed as the interface, constructed as the Pixi adapter — the owner
  // graduation ruling (2026-10-14) made Pixi the only graph renderer; the
  // GraphRenderer contract stays as the seam.
  const rendererRef = useRef<GraphRenderer | null>(null);
  const engineRef = useRef<EngineController | null>(null);
  const cameraRef = useRef({ x: 0, y: 0, zoom: 0.5 });
  const frameRef = useRef<EngineFrame | null>(null);
  const dirtyRef = useRef(false);
  const draggingRef = useRef<{ nodeId: string } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; camX: number; camY: number } | null>(null);
  const prefsSurface = local !== undefined ? "local" : "full";
  /** World radius per node — the label pass reads it live (refs, not closures). */
  const idRadiusRef = useRef<Map<string, number>>(new Map());

  // Loop-visible mirrors — hover/selection/prefs must NOT rebuild the GL stack.
  const loopStateRef = useRef<{ hovered: string | null; selected: string[]; paused: boolean }>({
    hovered: null,
    selected: [],
    paused: false,
  });
  const layoutModeRef = useRef<GraphLayoutMode>("force");
  /** The latest position frame (Focus bbox + label/pick passes read it live). */
  const positionsRef = useRef<{ positions: Float32Array; nodeIds: string[] } | null>(null);
  /** Node creation times, seconds since epoch (id → sec) — the label pass
   *  and the time-lapse pick filter read this live. */
  const nodeTimesSecRef = useRef<Map<string, number>>(new Map());
  /** The stamped / unstamped RendererEdge arrays (the Edges toggle swaps). */
  const edgesStampsOnRef = useRef<RendererEdge[]>([]);
  const edgesStampsOffRef = useRef<RendererEdge[]>([]);
  /** Time-lapse mirror readable by the pointer handlers (pick filtering). */
  const timeLapseRef = useRef<{ enabled: boolean; cutoffSec: number }>({
    enabled: false,
    cutoffSec: 0,
  });
  /** The Edges-toggle mirror — the GL lifecycle re-applies it on rebuild. */
  const timeLapseEdgesRef = useRef(true);
  /**
   * The label pass's display-name map (owner 2026-10-13 jank fix): rebuilt
   * ONLY when the renderer's node-order identity changes or the 60-frame
   * names-cache clear fires — building a fresh Map over ~7k nodes EVERY
   * FRAME was a steady per-frame allocation the GC had to chase.
   */
  const labelNamesRef = useRef<{ order: readonly string[] | null; map: Map<string, string> }>({
    order: null,
    map: new Map(),
  });
  /**
   * The once-per-mount camera fit (owner 2026-10-13 "blank while loading"
   * fix): the force path never fitted the opening camera — cameraRef starts
   * at the origin zoom 0.5, and cached layouts whose center isn't the origin
   * opened on empty canvas. Fitted on the FIRST engine frame, NEVER reset —
   * a display rebuild (filter toggle, reload) keeps the user's camera, like
   * Obsidian.
   */
  const fitDoneRef = useRef(false);
  /**
   * The label pass idle-skip signature (owner 2026-10-13 jank fix): labels
   * redraw only when a label input changed since the previous frame —
   * camera, position frame, hover, selection, the name map, the time-lapse
   * cut, or the canvas size. Static frames cost nothing (the canvas2d
   * clear + hundreds of shadowed text draws were the main-thread load).
   * NaN seeds guarantee the first frame always draws.
   */
  const labelSigRef = useRef<LabelDrawSignature>({
    camX: NaN, camY: NaN, zoom: NaN,
    frame: null,
    hovered: null,
    selected: null,
    names: null,
    tlEnabled: false, tlCutoff: 0,
    width: 0, height: 0,
  });

  const [topology, setTopology] = useState<GraphTopology | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  // The stage overlay between "topology shown (counts)" and "first pixels":
  // the engine init + warmup used to leave a blank canvas for seconds (owner
  // 2026-10-14: "loading modal overlay"). Ref mirrors the state so the rAF
  // loop can clear it without re-rendering every frame.
  const [awaitingFirstFrame, setAwaitingFirstFrame] = useState(false);
  const awaitingFirstFrameRef = useRef(false);
  const [prefs, setPrefs] = useState<GraphPrefs>(() => loadPrefs(prefsSurface));
  /**
   * The rail's expanded section (session-local): which NodeViewSection is
   * open — the chips open the rail onto their section. Both collapsed
   * (null) is a valid resting state; the rail itself stays open.
   */
  const [railSection, setRailSection] = useState<"selection" | "colors" | null>(null);
  /** The Selection section wrapper — the Selected chip scrolls to it. */
  const selectionSectionRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<
    | { kind: "node"; id: string; x: number; y: number }
    | { kind: "edge"; edge: GraphEdge; x: number; y: number }
    | null
  >(null);
  /** The multi-selection (the v1 register: click toggles, list is reorderable). */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [, setFps] = useState(0);
  /** Time-lapse chrome — session-local, like pause (never persisted). */
  const [timeLapseOpen, setTimeLapseOpen] = useState(false);
  const [timeLapsePlaying, setTimeLapsePlaying] = useState(false);
  const [timeLapsePos, setTimeLapsePos] = useState(0);
  const [timeLapseEdges, setTimeLapseEdges] = useState(true);

  const scope = useMemo(
    () => (items !== undefined ? new Set(items.map((item) => item.node.id)) : undefined),
    [items],
  );

  const anchorId = local?.anchorId;
  const depth = local?.depth;

  /** Load (or reload) the topology; debounced caller on subscribe below.
   *  Bails on an unchanged topology (signature over the node-id set and the
   *  edge list): every store event fans in here, and a new topology object
   *  with the same shape would still re-run the GL lifecycle effect —
   *  tearing the renderer down and reheating the physics for nothing (the
   *  blank-flash/jank fix, owner 2026-10-13: "Obsidian is snappy, ours goes
   *  blank from time to time"). */
  const topologySigRef = useRef<string | null>(null);
  const reload = useCallback(async () => {
    const result =
      anchorId !== undefined
        ? client.graphTopology({ anchor: anchorId, depth: depth ?? 2 })
        : client.graphTopology();
    const next = await Promise.resolve(result);
    let sig = `${next.nodes.length}:`;
    for (const node of next.nodes) sig += node.id;
    sig += "|";
    for (const edge of next.edges) sig += `${edge.source}>${edge.target}:${edge.kind};`;
    if (sig === topologySigRef.current) return;
    topologySigRef.current = sig;
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

  // Browser tab title for the FULL-SURFACE graph only: name the tab on
  // mount, restore the previous title on unmount. The string matches the
  // app shell's one-writer rule (App tabTitle names the graph hub
  // identically). The embedded local-graph card (right rail) must never
  // touch the title — the host page names the tab.
  useEffect(() => {
    if (local !== undefined) return;
    const previous = document.title;
    document.title = "Graph - Notees";
    return () => {
      document.title = previous;
    };
  }, [local]);

  /**
   * The display-shaping settings — field-level deps so unrelated prefs
   * (pause, radius, …) never rebuild the GL stack. layoutMode rides here
   * too: force ↔ fixed is a different pipeline, rebuilt on the switch.
   */
  const settings: GraphSettings = useMemo(
    () => ({
      showClasses: prefs.showClasses,
      journalYear: prefs.journalYear,
      journalMonth: prefs.journalMonth,
      journalDay: prefs.journalDay,
      showSystemPages: prefs.showSystemPages,
      showOrphans: prefs.showOrphans,
      families: prefs.families,
      semanticTopK: prefs.semanticTopK,
      semanticMinWeight: prefs.semanticMinWeight,
    }),
    [
      prefs.showClasses,
      prefs.journalYear,
      prefs.journalMonth,
      prefs.journalDay,
      prefs.showSystemPages,
      prefs.showOrphans,
      prefs.families,
      prefs.semanticTopK,
      prefs.semanticMinWeight,
    ],
  );

  const display = useMemo(
    () => (topology === null ? null : applyGraphSettings(topology, settings, scope)),
    [topology, settings, scope],
  );

  const counts = display === null ? null : graphCounts(display);

  // Keep the loop mirrors current without re-running the GL lifecycle.
  useEffect(() => {
    loopStateRef.current.paused = prefs.paused;
    engineRef.current?.setPaused(prefs.paused);
  }, [prefs.paused]);
  useEffect(() => {
    layoutModeRef.current = prefs.layoutMode;
  }, [prefs.layoutMode]);
  useEffect(() => {
    loopStateRef.current.selected = selectedIds;
    rendererRef.current?.setSelectedNodes(selectedIds);
  }, [selectedIds]);
  useEffect(() => {
    loopStateRef.current.hovered = hover !== null && hover.kind === "node" ? hover.id : null;
  }, [hover]);

  // Hover change → the renderer's neighborhood highlight (flag rewrite once
  // per change, never per frame), painted in the app's current accent — the
  // theme cache re-resolves on data-accent flips. The hovered node's label
  // (nudged, always-on) is the identifier; there is no hover tooltip box.
  const hoverRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = hover === null || hover.kind !== "node" ? null : hover.id;
    if (prev !== hoverRef.current) {
      rendererRef.current?.setHoverNeighborhood(prev, graphTheme().accent);
      hoverRef.current = prev;
    }
  }, [hover]);
  // Unmount only: restore the renderer's neutral (no-neighborhood) state.
  useEffect(
    () => () => {
      rendererRef.current?.setHoverNeighborhood(null);
    },
    [],
  );

  /** The time-lapse range across ALL displayed nodes (the scrubber maps onto it). */
  const createdRange = useMemo(() => {
    if (display === null) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const node of display.nodes) {
      const sec = Date.parse(node.createdAt) / 1000;
      if (Number.isFinite(sec)) {
        min = Math.min(min, sec);
        max = Math.max(max, sec);
      }
    }
    return min <= max ? { min, max } : null;
  }, [display]);

  // Time-lapse drive: mirror the cutoff for the pick/label passes and set
  // the renderer's time uniforms. Scrubbing only moves uniforms — no repack.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null) return;
    if (!timeLapseOpen || createdRange === null) {
      timeLapseRef.current = { enabled: false, cutoffSec: 0 };
      renderer.setTimeLapse(false, 0);
      return;
    }
    const cutoffSec =
      createdRange.min + ((createdRange.max - createdRange.min) * timeLapsePos) / 100;
    timeLapseRef.current = { enabled: true, cutoffSec };
    renderer.setTimeLapse(true, cutoffSec);
  }, [timeLapseOpen, timeLapsePos, createdRange]);

  // The Edges toggle: off = edges WITHOUT stamps (static at full opacity);
  // on = the topology-derived stamped array. The GL lifecycle effect
  // (declared below) re-applies the same choice on every rebuild — the
  // toggle only needs to reach the CURRENT renderer here.
  useEffect(() => {
    timeLapseEdgesRef.current = timeLapseEdges;
    rendererRef.current?.setEdges(
      timeLapseEdges ? edgesStampsOnRef.current : edgesStampsOffRef.current,
    );
  }, [timeLapseEdges]);

  // Playback: animate the cutoff from the current position to max over
  // ~20s, then rest. The simulation pause is independent of this.
  useEffect(() => {
    if (!timeLapseOpen || !timeLapsePlaying || createdRange === null) return;
    let raf = 0;
    const from = timeLapsePos;
    const start = performance.now();
    const tick = (): void => {
      const elapsed = performance.now() - start;
      const next = Math.min(100, from + (elapsed / TIME_LAPSE_DURATION_MS) * 100);
      setTimeLapsePos(next);
      if (next >= 100) {
        setTimeLapsePlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // timeLapsePos is read at play start; re-running per tick would restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLapsePlaying, timeLapseOpen, createdRange]);

  // Live physics tuning — no GL rebuild (force layout only).
  useEffect(() => {
    if (prefs.layoutMode !== "force") return;
    engineRef.current?.setConfig({
      preset: prefs.preset,
      centralGravity: prefs.centralGravityOn ? 30 : 0,
      linkCountAttraction: prefs.linkCountAttraction,
      massAccumulation: prefs.massAccumulation,
      clustering: prefs.clustering,
      clusterSeparation: prefs.clusterSeparation,
    });
  }, [prefs.preset, prefs.centralGravityOn, prefs.linkCountAttraction, prefs.massAccumulation, prefs.clustering, prefs.clusterSeparation, prefs.layoutMode]);

  // Color groups evaluation (first match wins). The ONLY painting mechanism
  // since the owner ruling (2026-10-13): the retired per-class color list
  // migrated one-time into groups below. Async — the worker client's query
  // runner is async.
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

  /** Query groups sort — the list order IS the first-match-wins priority. */
  const moveColorGroup = (fromIndex: number, toIndex: number): void => {
    setPrefs((prev) => {
      const next = [...prev.colorGroups];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved!);
      return { ...prev, colorGroups: next };
    });
  };

  // The one-time load migrations, run per device on mount (the debounced
  // prefs write lands the migrated shape back in the device store):
  //   1. persisted color groups may still hold pre-AST legacy rows (text-DSL
  //      strings) — parse through the DSL parser and re-persist as ASTs;
  //   2. the retired per-class color list (owner ruling 2026-10-13: colors
  //      unify on query groups) converts each entry into a class-matching
  //      color group appended AFTER the existing groups, and the list clears.
  // Already-migrated stores pass through untouched.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    migratedRef.current = true;
    setPrefs((prev) => {
      let colorGroups = prev.colorGroups;
      if (colorGroups.some((group) => isLegacyColorGroup(group))) {
        colorGroups = colorGroups.map((group) => migrateColorGroup(client, group));
      }
      if (prev.classColors.length > 0) {
        const fromClassColors: GraphColorGroup[] = prev.classColors.map((entry) => ({
          id: crypto.randomUUID(),
          label: client.getDisplayName(entry.classId) ?? "",
          color: entry.color,
          ast: {
            type: "group",
            logic: "and",
            children: [{ type: "class", classId: entry.classId }],
          } as Group,
        }));
        colorGroups = [...colorGroups, ...fromClassColors];
      }
      if (colorGroups === prev.colorGroups) return prev;
      return { ...prev, colorGroups, classColors: [] };
    });
  }, [client]);

  // The rail toggle register: a chip opens the rail onto its section; the
  // Selected chip also scrolls its section into view (the rail scrolls when
  // both sections are tall). jsdom has no scrollIntoView — feature-gated.
  useEffect(() => {
    if (!prefs.railOpen || railSection !== "selection") return;
    const section = selectionSectionRef.current;
    if (section !== null && typeof section.scrollIntoView === "function") {
      section.scrollIntoView({ block: "nearest" });
    }
  }, [prefs.railOpen, railSection]);

  // ── Node sizing + visuals: live, no GL rebuild ────────────────────────────
  // Radii and colors recompute whenever a driver changes and ride
  // renderer.setNodeVisuals (the renderer repacks on the next frame).
  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null || display === null) return;
    const { radii } = computeNodeSizing(
      display,
      prefs.nodeSize,
      prefs.baseNodeRadius,
      prefs.linkDirection,
    );
    idRadiusRef.current = radii;
    renderer.setNodeVisuals(
      display.nodes.map((node) => node.id),
      buildNodeVisuals(
        display,
        radii,
        groupColors,
        hexToRgba,
        resolveCssColor,
      ),
    );
  }, [display, prefs.nodeSize, prefs.baseNodeRadius, prefs.linkDirection, groupColors]);

  // ── Engine + renderer lifecycle (rebuilds only on the display set) ─────────
  // groupColors is deliberately NOT a dep: it resolves asynchronously seconds
  // after mount (the color-group queries), and the visuals effect above
  // already re-applies colors live — a lifecycle rebuild mid-load wiped the
  // canvas ("blank until all nodes get loaded", owner 2026-10-14).
  useEffect(() => {
    if (display === null) return;
    const canvas = canvasRef.current;
    const labelCanvas = labelCanvasRef.current;
    const container = containerRef.current;
    if (canvas === null || labelCanvas === null || container === null) return;

    awaitingFirstFrameRef.current = true;
    setAwaitingFirstFrame(true);

    const renderer: GraphRenderer = new GraphPixiRenderer({
      defaultRadius: 8,
      edgeWidth: 0.8,
    });
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

    const { radii, degrees } = computeNodeSizing(
      display,
      prefs.nodeSize,
      prefs.baseNodeRadius,
      prefs.linkDirection,
    );
    idRadiusRef.current = radii;
    const visuals = buildNodeVisuals(
      display,
      radii,
      groupColors,
      hexToRgba,
      resolveCssColor,
    );
    const nodeIds = display.nodes.map((node) => node.id);
    renderer.setNodeVisuals(nodeIds, visuals);

    // Creation times: per-node seconds (index-aligned with the nodeIds just
    // sent) + a per-edge stamp — the edge's own stamp when it has one, else
    // the max of its endpoints' (a synthesized parent/class/co-occurrence
    // edge never appears before both its endpoints).
    const createdSec = new Map<string, number>();
    const secondsByIndex = new Float32Array(display.nodes.length);
    display.nodes.forEach((node, i) => {
      const sec = Date.parse(node.createdAt) / 1000;
      if (Number.isFinite(sec)) {
        createdSec.set(node.id, sec);
        secondsByIndex[i] = sec;
      } else {
        secondsByIndex[i] = -Infinity; // un-stamped: never hidden
      }
    });
    renderer.setNodeTimes(secondsByIndex);
    nodeTimesSecRef.current = createdSec;
    const edgeCreatedSec = (edge: GraphEdge): number | undefined => {
      const endpoints = Math.max(
        createdSec.get(edge.source) ?? -Infinity,
        createdSec.get(edge.target) ?? -Infinity,
      );
      if (edge.createdAt !== null) {
        const own = Date.parse(edge.createdAt) / 1000;
        if (Number.isFinite(own)) return Math.max(own, endpoints);
      }
      return endpoints === -Infinity ? undefined : endpoints;
    };

    const fixedLayout =
      layoutModeRef.current === "force" ? null : computeFixedLayout(layoutModeRef.current, display);

    const engineNodes = display.nodes.map((node) => {
      const cachedPos = cached.get(node.id);
      const fixed = fixedLayout?.get(node.id);
      const start = fixed ?? cachedPos;
      return {
        nodeUuid: node.id,
        x: start?.x,
        y: start?.y,
        connectionCount: degrees.get(node.id)?.all ?? 0,
        mass: node.mass,
        pinned: fixed !== undefined,
      };
    });

    const engineEdges = display.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.kind,
      weight: edge.weight,
    }));
    const renderEdges: RendererEdge[] = display.edges.map((edge) => {
      const createdAt = edgeCreatedSec(edge);
      return {
        source: edge.source,
        target: edge.target,
        linkType: LINK_TYPE_IDS[edge.kind],
        // exactOptionalPropertyTypes: omit the key entirely when un-stamped.
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(edge.kind === "semantic" || edge.kind === "temporal"
          ? { width: 0.7 + Math.min(2.1, edge.weight * 0.3) }
          : {}),
        color:
          edge.kind === "semantic" || edge.kind === "temporal"
            ? ([...theme.semanticEdge, 0.55] as [number, number, number, number])
            : ([...theme.edgeDefault, 0.5] as [number, number, number, number]),
      };
    });
    edgesStampsOnRef.current = renderEdges;
    // The Edges=off time-lapse variant: same topology, no stamps (static).
    edgesStampsOffRef.current = renderEdges.map(({ createdAt: _stamp, ...rest }) => rest);
    // Re-apply the session-local time-lapse state on the FRESH renderer
    // (the driving effects above ran against the pre-rebuild instance):
    // the cutoff + the Edges=off edge variant survive topology reloads.
    renderer.setEdges(
      timeLapseEdgesRef.current ? edgesStampsOnRef.current : edgesStampsOffRef.current,
    );
    if (timeLapseRef.current.enabled) {
      renderer.setTimeLapse(true, timeLapseRef.current.cutoffSec);
    }

    // Instant paint from the cached layout: a returning workspace paints the
    // previous session's map in the same tick as the renderer init — no blank
    // window while the engine warms up. Uncached nodes sit at the origin until
    // the first engine frame re-homes them (only when the cache covers the
    // graph; a stale/partial cache would misrepresent the layout).
    if (fixedLayout === null && nodeIds.length > 0) {
      let covered = 0;
      for (const id of nodeIds) if (cached.has(id)) covered++;
      if (covered / nodeIds.length >= 0.7) {
        const positions = new Float32Array(nodeIds.length * 2);
        nodeIds.forEach((id, i) => {
          const p = cached.get(id);
          if (p !== undefined) {
            positions[i * 2] = p.x;
            positions[i * 2 + 1] = p.y;
          }
        });
        renderer.updatePositions(positions, nodeIds);
        positionsRef.current = { positions, nodeIds };
        frameRef.current = {
          positions,
          nodeIds,
          nodeCount: nodeIds.length,
          energy: 0,
          ticks: 0,
          settled: false,
        };
        cameraRef.current = renderer.fitToCanvas();
        fitDoneRef.current = true;
        renderer.setCamera(cameraRef.current.x, cameraRef.current.y, cameraRef.current.zoom);
        renderer.render();
        awaitingFirstFrameRef.current = false;
        setAwaitingFirstFrame(false);
      }
    }

    if (fixedLayout === null) {
      const engine = new EngineController((frame) => {
        frameRef.current = frame;
        dirtyRef.current = true;
      });
      engineRef.current = engine;
      // Warm-quiet start (owner 2026-10-13): when ≥70% of the nodes carry
      // cached positions the layout is already shaped — seed the engine at
      // 0.2 activity so it opens nearly still and finishes cooling in a
      // second or two; below the threshold the full 1.0 unfold runs.
      const warmStart =
        display.nodes.length > 0 && cached.size / display.nodes.length >= 0.7;
      engine.init(
        engineNodes.map(({ nodeUuid, x, y, connectionCount, mass, pinned }) => ({
          nodeUuid,
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {}),
          connectionCount,
          mass,
          pinned,
        })),
        engineEdges,
        {
          preset: prefs.preset,
          centralGravity: prefs.centralGravityOn ? 30 : 0,
          linkCountAttraction: prefs.linkCountAttraction,
          massAccumulation: prefs.massAccumulation,
          clustering: prefs.clustering,
          clusterSeparation: prefs.clusterSeparation,
          ...(warmStart ? { initialAlpha: 0.2 } : {}),
        },
      );
      engine.setPaused(loopStateRef.current.paused);
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
      frameRef.current = { positions, nodeIds: order, nodeCount: order.length, energy: 0, ticks: 0, settled: true };
      positionsRef.current = { positions, nodeIds: order };
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
        positionsRef.current = { positions: frame.positions, nodeIds: frame.nodeIds };
      }
      // Once per mount: frame the graph the moment the first engine frame
      // arrives (the force path never fitted the opening camera — see
      // fitDoneRef). Never re-fits: the user's camera survives rebuilds.
      if (!fitDoneRef.current && frameRef.current !== null) {
        fitDoneRef.current = true;
        cameraRef.current = renderer.fitToCanvas();
      }
      const engine = engineRef.current;
      if (engine !== null && engine.runsOnMainThread && !loopStateRef.current.paused) {
        engine.step();
      }
      const cam = cameraRef.current;
      renderer.setCamera(cam.x, cam.y, cam.zoom);
      renderer.setEdgeMask(edgeMaskForZoom(cam.zoom));
      renderer.render();
      // First real pixels are on the canvas — the stage overlay steps aside.
      if (awaitingFirstFrameRef.current) {
        awaitingFirstFrameRef.current = false;
        setAwaitingFirstFrame(false);
      }

      const lctx = labelCanvas.getContext("2d");
      if (lctx !== null) {
        if (frames % 60 === 0) {
          namesCache.clear();
          labelNamesRef.current.order = null; // force the name map rebuild
        }
        const nodeOrder = renderer.nodeOrder;
        if (labelNamesRef.current.order !== nodeOrder) {
          labelNamesRef.current = {
            order: nodeOrder,
            map: new Map(nodeOrder.map((id) => [id, nameOf(id)])),
          };
        }
        const tl = timeLapseRef.current;
        const selected = loopStateRef.current.selected;
        const nextSig: LabelDrawSignature = {
          camX: cam.x, camY: cam.y, zoom: cam.zoom,
          frame,
          hovered: loopStateRef.current.hovered,
          selected,
          names: labelNamesRef.current.map,
          tlEnabled: tl.enabled, tlCutoff: tl.cutoffSec,
          width: labelCanvas.width, height: labelCanvas.height,
        };
        if (labelSignatureChanged(labelSigRef.current, nextSig)) {
          const labelFrame: LabelFrame = {
            ctx: lctx,
            width: labelCanvas.width,
            height: labelCanvas.height,
            dpr: window.devicePixelRatio || 1,
            zoom: cam.zoom,
            positions: renderer.nodePositions,
            order: nodeOrder,
            names: labelNamesRef.current.map,
            radii: idRadiusRef.current,
            worldToScreen: (wx, wy) => renderer.worldToScreen(wx, wy),
            baseNodeRadius: 8,
            hovered: loopStateRef.current.hovered,
            selected: selected.length > 0 ? selected[selected.length - 1]! : null,
            colors: graphTheme(),
            createdTimes: nodeTimesSecRef.current,
            timeCutoffSec: tl.enabled ? tl.cutoffSec : undefined,
          };
          drawLabels(labelFrame);
          labelSigRef.current = nextSig;
        }
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
  }, [display, client]);

  // ── Selection helpers ──────────────────────────────────────────────────────
  const toggleSelected = (id: string): void =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  const moveSelectionItem = (fromIndex: number, toIndex: number): void =>
    setSelectedIds((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved!);
      return next;
    });

  /**
   * The rail toggle register (the top-bar chips): a chip opens the rail
   * onto its section; clicking the active section's chip again closes the
   * rail. The Selected chip additionally scrolls to its section (effect).
   */
  const openRailSection = (section: "selection" | "colors"): void => {
    patch({ railOpen: true });
    setRailSection(section);
  };
  const toggleColorsRail = (): void => {
    if (!prefs.railOpen) openRailSection("colors");
    else if (railSection === "colors") patch({ railOpen: false });
    else setRailSection("colors");
  };
  const toggleSelectionRail = (): void => {
    if (!prefs.railOpen) openRailSection("selection");
    else if (railSection === "selection") patch({ railOpen: false });
    else setRailSection("selection");
  };

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

  /**
   * Node picking with the time-lapse rule: a node created after the current
   * cutoff is fully hidden on the GL canvas — it must not be hoverable,
   * draggable, or openable either.
   */
  const pickVisibleNode = (worldX: number, worldY: number, radius: number): string | null => {
    const renderer = rendererRef.current;
    if (renderer === null) return null;
    const id = renderer.pickNode(worldX, worldY, radius);
    if (id === null) return null;
    const tl = timeLapseRef.current;
    if (tl.enabled) {
      const created = nodeTimesSecRef.current.get(id);
      if (created !== undefined && created > tl.cutoffSec) return null;
    }
    return id;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const renderer = rendererRef.current;
    const engine = engineRef.current;
    if (renderer === null) return;
    const world = worldAt(event);
    const nodeId = pickVisibleNode(world.x, world.y, 24 / cameraRef.current.zoom);
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
      // Local override for instant feel (v1); the worker frame lands next tick.
      renderer.overridePosition(draggingRef.current.nodeId, world.x, world.y);
      if (engine !== null) {
        engine.dragMove(draggingRef.current.nodeId, world.x, world.y);
      } else {
        // Fixed layout: drag rides the renderer's position override only.
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
      event.currentTarget.style.cursor = "grabbing";
      return;
    }
    if (panRef.current !== null) {
      const dpr = window.devicePixelRatio || 1;
      const dx = (event.clientX - panRef.current.startX) * dpr;
      const dy = (event.clientY - panRef.current.startY) * dpr;
      cameraRef.current.x = panRef.current.camX - dx / cameraRef.current.zoom;
      cameraRef.current.y = panRef.current.camY - dy / cameraRef.current.zoom;
      event.currentTarget.style.cursor = "grabbing";
      return;
    }
    const nodeId = pickVisibleNode(world.x, world.y, 24 / cameraRef.current.zoom);
    const rect = event.currentTarget.getBoundingClientRect();
    const tip = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    event.currentTarget.style.cursor = nodeId !== null ? "pointer" : "grab";
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
      const still = pickVisibleNode(world.x, world.y, 24 / cameraRef.current.zoom);
      // An un-dragged click toggles the node in the selection (the v1 register).
      if (still === dragged) toggleSelected(dragged);
      return;
    }
    if (panRef.current !== null) {
      const moved =
        Math.abs(event.clientX - panRef.current.startX) + Math.abs(event.clientY - panRef.current.startY);
      // A click on empty space clears the selection (the v1 register).
      if (moved < 4) setSelectedIds([]);
    }
    panRef.current = null;
  };

  // v1 navigation: cursor-anchored zoom (world point under the cursor stays
  // put) with the v1 clamp range — shared with the minimap wheel, the dock
  // buttons, and the keyboard shortcuts via cameraMath.
  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>): void => {
    const renderer = rendererRef.current;
    if (renderer === null) return;
    const world = worldAt(event);
    cameraRef.current = zoomAtWorldPoint(
      cameraRef.current,
      world.x,
      world.y,
      wheelZoomFactor(event.deltaY),
    );
  };

  /** Dock/keyboard zoom: anchored at the canvas center (the camera position). */
  const zoomBy = (direction: 1 | -1): void => {
    cameraRef.current = zoomAtCenter(cameraRef.current, direction);
  };

  /** Focus: fit the selection's bounding box (single node → center at 1.5). */
  const focusSelection = (): void => {
    const frame = positionsRef.current;
    const canvas = canvasRef.current;
    if (frame === null || canvas === null || selectedIds.length === 0) return;
    if (selectedIds.length === 1) {
      const idx = frame.nodeIds.indexOf(selectedIds[0]!);
      if (idx < 0) return;
      cameraRef.current = {
        x: frame.positions[idx * 2]!,
        y: frame.positions[idx * 2 + 1]!,
        zoom: clampZoom(1.5),
      };
      return;
    }
    const bbox = bboxForNodes(frame.positions, frame.nodeIds, new Set(selectedIds));
    const dpr = window.devicePixelRatio || 1;
    const fit = fitBoundingBoxCamera(
      bbox,
      canvas.width / dpr,
      canvas.height / dpr,
      60,
    );
    if (fit !== null) cameraRef.current = fit;
  };

  /**
   * The graph surface keyboard register (Obsidian parity): +/- zoom at the
   * canvas center, arrows pan (Shift = 4×), F focuses the selection, R
   * recenters. Stage-scoped only — the graph also renders inside the local
   * card on a page, so no window listeners. Modifiers other than Shift and
   * text-editing targets pass through untouched.
   */
  const onStageKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }
    const step = 60 * (event.shiftKey ? 4 : 1);
    switch (event.key) {
      case "+":
      case "=":
        zoomBy(1);
        event.preventDefault();
        return;
      case "-":
        zoomBy(-1);
        event.preventDefault();
        return;
      case "ArrowLeft":
        cameraRef.current = panByScreenDelta(cameraRef.current, -step, 0);
        event.preventDefault();
        return;
      case "ArrowRight":
        cameraRef.current = panByScreenDelta(cameraRef.current, step, 0);
        event.preventDefault();
        return;
      case "ArrowUp":
        cameraRef.current = panByScreenDelta(cameraRef.current, 0, -step);
        event.preventDefault();
        return;
      case "ArrowDown":
        cameraRef.current = panByScreenDelta(cameraRef.current, 0, step);
        event.preventDefault();
        return;
      default:
        break;
    }
    if (event.key === "f" || event.key === "F") focusSelection();
    else if (event.key === "r" || event.key === "R") recenter();
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    // v1: double-click opens the node under the cursor and clears the selection.
    const renderer = rendererRef.current;
    if (renderer === null) return;
    const world = worldAt(event);
    const hit = pickVisibleNode(world.x, world.y, 24 / cameraRef.current.zoom);
    if (hit !== null) {
      setSelectedIds([]);
      onNodeClick?.(hit);
    }
  };

  const recenter = (): void => {
    const renderer = rendererRef.current;
    if (renderer === null) return;
    cameraRef.current = renderer.fitToCanvas();
  };

  const onMinimapNavigate = (worldX: number, worldY: number): void => {
    cameraRef.current = { ...cameraRef.current, x: worldX, y: worldY };
  };

  const patch = (partial: Partial<GraphPrefs>): void =>
    setPrefs((prev) => ({ ...prev, ...partial }));

  /**
   * The filtered-out empty state's reset affordance: back to the shipped
   * defaults (every family on, classes and orphans visible, the journal
   * levels and the semantic defaults off/on per DEFAULT_GRAPH_SETTINGS).
   * Scoped collections (the registry mode) offer no reset — the scope is the
   * collection, not a user-toggled filter.
   */
  const resetFilters = (): void =>
    patch({
      showClasses: DEFAULT_GRAPH_SETTINGS.showClasses,
      journalYear: DEFAULT_GRAPH_SETTINGS.journalYear,
      journalMonth: DEFAULT_GRAPH_SETTINGS.journalMonth,
      journalDay: DEFAULT_GRAPH_SETTINGS.journalDay,
      showSystemPages: DEFAULT_GRAPH_SETTINGS.showSystemPages,
      showOrphans: DEFAULT_GRAPH_SETTINGS.showOrphans,
      families: { ...DEFAULT_GRAPH_SETTINGS.families },
    });

  // ── The right rail (Selection + Colors) ────────────────────────────────────
  // Curation chrome, full surface only: a flex sibling of the stage so the
  // drawable area excludes it (the minimap hugs the remaining canvas).
  // Sections are kit NodeViewSection collapsibles, both resting collapsed.

  /** The rail's Selection section: the permanent node search (search-to-select —
   *  the shared NodeSelector, no create: picking adds to the selection and
   *  never changes topology) above the reorderable selected list. */
  const selectionSection = (
    <div ref={selectionSectionRef}>
      <NodeViewSection
        title="Selection"
        count={selectedIds.length}
        expanded={railSection === "selection"}
        onExpandedChange={(expanded) => setRailSection(expanded ? "selection" : null)}
      >
        <div className="nt-graph__rail-stack">
          <NodeSelector
            client={client}
            trigger="inline"
            searchMode="all"
            noCreate
            value={selectedIds}
            searchPlaceholder="Search to select…"
            onAdd={(node) =>
              setSelectedIds((prev) => (prev.includes(node.id) ? prev : [...prev, node.id]))
            }
          />
          {selectedIds.length === 0 ? (
            <EmptyState
              title="No nodes selected"
              description="Search above or click nodes in the graph."
            />
          ) : (
            <>
              <ListSortable
                items={selectedIds.map((id) => ({ id }))}
                onReorder={moveSelectionItem}
                itemClassName="nt-graph__selected-item"
                renderText={(item) => (
                  <span className="nt-graph__selected-name">
                    {client.getDisplayName(String(item.id)) ?? String(item.id)}
                  </span>
                )}
                renderAction={(item) => (
                  <Button
                    variant="ghost"
                    size="xs"
                    icon="mdi mdi-close"
                    aria-label={`Remove ${client.getDisplayName(String(item.id)) ?? String(item.id)}`}
                    onClick={() =>
                      setSelectedIds((prev) => prev.filter((s) => s !== item.id))
                    }
                  />
                )}
              />
              <Button
                variant="ghost"
                size="sm"
                icon="mdi mdi-trash-can-outline"
                aria-label="Clear selection"
                onClick={() => setSelectedIds([])}
              >
                Clear
              </Button>
            </>
          )}
        </div>
      </NodeViewSection>
    </div>
  );

  /** The rail's Colors section: the query groups ONLY (owner ruling
   *  2026-10-13 — the class-colors list retired into groups) — the visual
   *  query builder over a Group AST; the list order IS the first-match-wins
   *  paint priority. */
  const colorsSection = (
    <NodeViewSection
      title="Colors"
      expanded={railSection === "colors"}
      onExpandedChange={(expanded) => setRailSection(expanded ? "colors" : null)}
    >
      <div className="nt-graph__rail-stack">
        <div className="nt-graph__rail-row">
          <span className="nt-graph__rail-heading">Query groups</span>
          <BooleanToggle
            size="sm"
            label="Paint groups"
            labelPosition="right"
            checked={prefs.colorGroupsOn}
            onChange={(checked) => patch({ colorGroupsOn: checked })}
          />
        </div>
        <p className="nt-graph__rail-hint">
          Query groups paint matching nodes in their color — first match wins,
          top to bottom; a node with no match keeps its own color.
        </p>
        {prefs.colorGroups.length > 0 && (
          <ListSortable
            items={prefs.colorGroups.map((group) => ({ ...group, id: group.id }))}
            onReorder={moveColorGroup}
            renderText={(group) => (
              <div className="nt-graph__rail-group">
                <TextField
                  size="sm"
                  aria-label="Group name"
                  placeholder="Group name (optional)"
                  value={group.label}
                  onChange={(event) =>
                    patch({
                      colorGroups: prefs.colorGroups.map((g) =>
                        g.id === group.id ? { ...g, label: event.target.value } : g,
                      ),
                    })
                  }
                />
                {isLegacyColorGroup(group) || group.ast === null ? (
                  <p role="alert" className="nt-graph__rail-error">
                    {isLegacyColorGroup(group)
                      ? "Stored query is being migrated…"
                      : (group.error ?? "Invalid query")}
                  </p>
                ) : (
                  <FilterBlockBuilder
                    client={client}
                    group={group.ast}
                    // The full offered set — every condition kind evaluates
                    // through the query runner, so all are paintable.
                    config={{ class: true, properties: true, dateRange: true }}
                    onChange={(ast) =>
                      patch({
                        colorGroups: prefs.colorGroups.map((g) =>
                          g.id === group.id ? { ...g, ast } : g,
                        ),
                      })
                    }
                  />
                )}
              </div>
            )}
            renderActions={(group) => [
              <ColorButton
                key="color"
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
              />,
              <Button
                key="remove"
                variant="ghost"
                size="xs"
                icon="mdi mdi-close"
                aria-label={`Remove ${group.label || "group"}`}
                onClick={() =>
                  patch({ colorGroups: prefs.colorGroups.filter((g) => g.id !== group.id) })
                }
              />,
            ]}
          />
        )}
        <Button
          variant="outline"
          size="xs"
          icon="mdi mdi-plus"
          aria-label="Add group"
          onClick={() =>
            patch({
              colorGroups: [
                ...prefs.colorGroups,
                {
                  id: crypto.randomUUID(),
                  label: "",
                  color: "sky",
                  ast: { type: "group", logic: "and", children: [] },
                },
              ],
            })
          }
        >
          Add group
        </Button>
      </div>
    </NodeViewSection>
  );

  /** The rail itself (full surface only): kit Card + the two sections. */
  const railOpenFull = local === undefined && prefs.railOpen;
  const rail = railOpenFull ? (
    <aside className="nt-graph__rail" aria-label="Graph rail">
      <Card variant="outlined" paddingSize="sm" className="nt-graph__rail-card">
        {selectionSection}
        {colorsSection}
      </Card>
    </aside>
  ) : null;

  // ── Render ─────────────────────────────────────────────────────────────────
  if (display === null || counts === null) {
    return (
      <div className="nt-graph nt-graph--loading">
        <LoadingScreen fullscreen={false} label="Projecting the workspace topology…" />
      </div>
    );
  }

  if (glError !== null) {
    // One honest register (owner 2026-10-14 graduation): the graph renderer
    // failed — say what actually happened (a shader compile/link failure on
    // strict linkers, or the browser denying the GPU backend).
    const shaderFailure = /shader|link|compile/i.test(glError);
    return (
      <div className="nt-graph nt-graph--error">
        <EmptyState
          title="Graph renderer failed"
          description={
            shaderFailure
              ? `The graph shaders failed to build in this browser. (${glError})`
              : `The graph could not start its renderer in this browser. (${glError})`
          }
        />
      </div>
    );
  }

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

  /** The settings popover rows (physics + sizing only; what-to-draw lives in
   *  the Visibility popover, layout mode + time-lapse in the bottom mode bar). */
  const settingsPanel = (
    <div className="nt-graph__settings">
      {prefs.layoutMode === "force" && (
        <>
          <div className="nt-graph__settings-row">
            <span className="nt-graph__settings-label">Physics preset</span>
            <Dropdown
              size="sm"
              options={[
                { value: "sparse", label: "Sparse" },
                { value: "balanced", label: "Balanced" },
                { value: "compact", label: "Compact" },
                { value: "clustered", label: "Clustered" },
              ]}
              value={prefs.preset}
              onChange={(value) => value !== null && patch({ preset: value as PhysicsPreset })}
              ariaLabel="Physics preset"
            />
          </div>
          <BooleanToggle
            size="sm"
            label="Simulation"
            description="Run or pause the physics"
            labelPosition="left"
            checked={!prefs.paused}
            onChange={(checked) => patch({ paused: !checked })}
          />
          <BooleanToggle
            size="sm"
            label="Link-count attraction"
            description="More connected nodes attract more strongly"
            labelPosition="left"
            checked={prefs.linkCountAttraction}
            onChange={(checked) => patch({ linkCountAttraction: checked })}
          />
          <BooleanToggle
            size="sm"
            label="Central gravity"
            description="Pull components toward the middle"
            labelPosition="left"
            checked={prefs.centralGravityOn}
            onChange={(checked) => patch({ centralGravityOn: checked })}
          />
          <BooleanToggle
            size="sm"
            label="Mass accumulation"
            description="Parents resist movement by descendant weight"
            labelPosition="left"
            checked={prefs.massAccumulation}
            onChange={(checked) => patch({ massAccumulation: checked })}
          />
          <BooleanToggle
            size="sm"
            label="Clustering"
            description="Communities hold together and separate from each other"
            labelPosition="left"
            checked={prefs.clustering}
            onChange={(checked) => patch({ clustering: checked })}
          />
          {prefs.clustering && (
            <label className="nt-graph__settings-slider">
              <span>Cluster separation ({prefs.clusterSeparation})</span>
              <Slider
                min={0}
                max={100}
                step={1}
                value={prefs.clusterSeparation}
                onChange={(value) => patch({ clusterSeparation: value })}
                aria-label="Cluster separation"
              />
            </label>
          )}
          <div className="nt-graph__settings-row">
            <span className="nt-graph__settings-label">Node sizing</span>
            <SelectionButton
              size="sm"
              options={[
                { value: "uniform", icon: "mdi mdi-circle-outline", label: "Uniform" },
                { value: "connections", icon: "mdi mdi-connection", label: "Connections" },
                { value: "mass", icon: "mdi mdi-weight", label: "Mass" },
                { value: "content", icon: "mdi mdi-note-outline", label: "Content" },
              ]}
              value={prefs.nodeSize}
              onChange={(value) => patch({ nodeSize: value as NodeSizeMode })}
            />
          </div>
          <label className="nt-graph__settings-slider">
            <span>Node radius ({prefs.baseNodeRadius})</span>
            <Slider
              min={3}
              max={20}
              step={1}
              value={prefs.baseNodeRadius}
              onChange={(value) => patch({ baseNodeRadius: value })}
              aria-label="Node radius"
            />
          </label>
          {prefs.nodeSize === "connections" && (
            <div className="nt-graph__settings-row">
              <span className="nt-graph__settings-label">Link direction</span>
              <SelectionButton
                size="sm"
                options={[
                  { value: "all", icon: "mdi mdi-swap-horizontal", label: "All links" },
                  { value: "in", icon: "mdi mdi-call-received", label: "Incoming" },
                  { value: "out", icon: "mdi mdi-call-made", label: "Outgoing" },
                ]}
                value={prefs.linkDirection}
                onChange={(value) => patch({ linkDirection: value as LinkDirection })}
              />
            </div>
          )}
        </>
      )}
    </div>
  );

  /** The Visibility popover (the eye): everything that decides WHAT is drawn
   *  — link families, node classes, orphans, journal visibility, and the
   *  semantic web's two bound sliders riding next to their family toggles. */
  const filtersActive =
    FAMILY_LABELS.some(({ key }) => prefs.families[key] !== true) ||
    !prefs.showClasses ||
    !prefs.showOrphans;

  const filtersPanel = (
    <div className="nt-graph__settings">
      <span className="nt-graph__settings-heading">Link families</span>
      <div className="nt-graph__filters-chips">
        {FAMILY_LABELS.map(({ key, label }) => (
          <Chip
            key={key}
            active={prefs.families[key] === true}
            onClick={() =>
              patch({ families: { ...prefs.families, [key]: !prefs.families[key] } })
            }
          >
            {label}
          </Chip>
        ))}
      </div>
      <BooleanToggle
        size="sm"
        label="Class nodes"
        description="Show classes as nodes"
        labelPosition="left"
        checked={prefs.showClasses}
        onChange={(checked) => patch({ showClasses: checked })}
      />
      <BooleanToggle
        size="sm"
        label="Orphans"
        description="Nodes with no visible links"
        labelPosition="left"
        checked={prefs.showOrphans}
        onChange={(checked) => patch({ showOrphans: checked })}
      />
      {(prefs.families.semantic === true || prefs.families.temporal === true) && (
        <>
          <span className="nt-graph__settings-heading">Semantic detail</span>
          <label className="nt-graph__settings-slider">
            <span>Top-{prefs.semanticTopK} edges per node</span>
            <Slider
              min={1}
              max={12}
              step={1}
              value={prefs.semanticTopK}
              onChange={(value) => patch({ semanticTopK: value })}
              aria-label="Semantic edges per node"
            />
          </label>
          <label className="nt-graph__settings-slider">
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
        </>
      )}
      <div className="nt-graph__settings-visibility">
        <span className="nt-graph__settings-heading">Visibility</span>
        <BooleanToggle
          size="sm"
          label="Day pages"
          description="Daily journal pages"
          labelPosition="left"
          checked={prefs.journalDay}
          onChange={(checked) => patch({ journalDay: checked })}
        />
        <BooleanToggle
          size="sm"
          label="Month pages"
          description="Monthly journal pages"
          labelPosition="left"
          checked={prefs.journalMonth}
          onChange={(checked) => patch({ journalMonth: checked })}
        />
        <BooleanToggle
          size="sm"
          label="Year pages"
          description="Yearly journal pages"
          labelPosition="left"
          checked={prefs.journalYear}
          onChange={(checked) => patch({ journalYear: checked })}
        />
        <BooleanToggle
          size="sm"
          label="System pages"
          description="The Inbox and legacy scaffolding"
          labelPosition="left"
          checked={prefs.showSystemPages}
          onChange={(checked) => patch({ showSystemPages: checked })}
        />
      </div>
    </div>
  );

  /** The layout mode bar (the v1 register): a transparent dock centered at
   *  the bottom edge of the stage, overlaying the graph. The time-lapse
   *  toggle rides the same bar; its timeline strip opens just above. */
  const modeBar = (
    <div className="nt-graph__modebar">
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
      <Button
        variant="ghost"
        size="sm"
        icon="mdi mdi-animation-play"
        active={timeLapseOpen}
        aria-pressed={timeLapseOpen}
        aria-label="Time lapse"
        title="Time lapse"
        onClick={() => {
          if (timeLapseOpen) {
            setTimeLapseOpen(false);
            setTimeLapsePlaying(false);
          } else {
            setTimeLapsePos(0);
            setTimeLapsePlaying(false);
            setTimeLapseOpen(true);
          }
        }}
      />
    </div>
  );

  /** The time-lapse timeline strip (just above the mode bar): play/pause,
   *  the scrubber over [minCreated, maxCreated], the Edges switch, close. */
  const timeLapseStrip = timeLapseOpen && (
    <div className="nt-graph__timelapse">
      <Button
        variant="ghost"
        size="sm"
        icon={timeLapsePlaying ? "mdi mdi-pause" : "mdi mdi-play"}
        active={timeLapsePlaying}
        aria-label={timeLapsePlaying ? "Pause time-lapse" : "Play time-lapse"}
        title={timeLapsePlaying ? "Pause time-lapse" : "Play time-lapse"}
        onClick={() => setTimeLapsePlaying((playing) => !playing)}
      />
      <Slider
        className="nt-graph__timelapse-slider"
        min={0}
        max={100}
        step={1}
        value={Math.round(timeLapsePos)}
        onChange={(value) => {
          setTimeLapsePlaying(false);
          setTimeLapsePos(value);
        }}
        aria-label="Time-lapse position"
      />
      <BooleanToggle
        size="sm"
        label="Edges"
        labelPosition="right"
        checked={timeLapseEdges}
        onChange={(checked) => setTimeLapseEdges(checked)}
      />
      <Button
        variant="ghost"
        size="sm"
        icon="mdi mdi-close"
        aria-label="Close time-lapse"
        title="Close time-lapse"
        onClick={() => {
          setTimeLapseOpen(false);
          setTimeLapsePlaying(false);
        }}
      />
    </div>
  );

  /** The bottom-left control dock (mirrors the minimap's bottom-right):
   *  recenter + pause (moved off the top bar), zoom in/out, and Focus for
   *  the current selection. */
  const controlDock = (
    <div className="nt-graph__dock">
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
      <Button
        variant="ghost"
        size="sm"
        icon="mdi mdi-magnify-plus-outline"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => zoomBy(1)}
      />
      <Button
        variant="ghost"
        size="sm"
        icon="mdi mdi-magnify-minus-outline"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => zoomBy(-1)}
      />
      {selectedIds.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          icon="mdi mdi-focus-field"
          aria-label="Focus selection"
          title="Focus selection"
          onClick={focusSelection}
        />
      )}
    </div>
  );

  return (
    <div className={railOpenFull ? "nt-graph nt-graph--rail-open" : "nt-graph"}>
      <div className="nt-graph__toolbar" role="toolbar" aria-label="Graph settings">
        <ButtonWithPanel
          icon="mdi mdi-cog-outline"
          size="sm"
          variant="ghost"
          panelPosition="bottom"
          panelAlignment="start"
          panelWidth={320}
          title="Graph settings"
          tooltip="Graph settings"
          buttonClassName="nt-graph__settings-trigger"
        >
          {settingsPanel}
        </ButtonWithPanel>
        {local === undefined && (
          <ButtonWithPanel
            icon="mdi mdi-eye-outline"
            size="sm"
            variant="ghost"
            panelPosition="bottom"
            panelAlignment="start"
            panelWidth={300}
            title="Visibility"
            tooltip="Visibility"
            active={filtersActive}
            buttonProps={{ "aria-pressed": filtersActive }}
          >
            {filtersPanel}
          </ButtonWithPanel>
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
            {selectedIds.length > 0 && (
              <Chip
                active={prefs.railOpen && railSection === "selection"}
                aria-label="Selected nodes"
                onClick={toggleSelectionRail}
              >
                Selected · {selectedIds.length}
              </Chip>
            )}
            <Chip
              active={prefs.colorGroupsOn || prefs.colorGroups.length > 0}
              aria-pressed={prefs.colorGroupsOn}
              onClick={toggleColorsRail}
            >
              Colors
            </Chip>
          </>
        )}
      </div>
      <div className="nt-graph__main">
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
          {modeBar}
          {timeLapseStrip}
        </div>
      ) : (
      <div
        className="nt-graph__stage"
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onStageKeyDown}
        onPointerDown={(event) => {
          // The canvas itself owns drag/pan; chrome clicks keep their focus.
          if (event.target === canvasRef.current) event.currentTarget.focus();
        }}
      >
        {modeBar}
        {timeLapseStrip}
        {controlDock}
        <canvas
          ref={canvasRef}
          className="nt-graph__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={onDoubleClick}
        />
        <canvas ref={labelCanvasRef} className="nt-graph__labels" aria-hidden="true" />
        {local === undefined && (
          <canvas
            ref={minimapCanvasRef}
            className="nt-graph__minimap"
            width={200}
            height={140}
            aria-label="Graph minimap"
            onWheel={(event) => {
              // Scroll-to-zoom with the main canvas's exact math: the world
              // point under the cursor (via the minimap's own linear map)
              // stays put. Pinch (ctrlKey) behaves the same as the main wheel.
              const rect = event.currentTarget.getBoundingClientRect();
              const world = GraphMinimap.screenToWorld(
                ((event.clientX - rect.left) / rect.width) * event.currentTarget.width,
                ((event.clientY - rect.top) / rect.height) * event.currentTarget.height,
                event.currentTarget.width,
                event.currentTarget.height,
                frameRef.current,
                cameraRef.current,
              );
              cameraRef.current = zoomAtWorldPoint(
                cameraRef.current,
                world.x,
                world.y,
                wheelZoomFactor(event.deltaY),
              );
            }}
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
        {/* The hand-rolled tooltip is EDGES-only (owner ruling 2026-10-13):
            node hover identifies the node through the nudged always-on
            label — no tooltip box — so only the edge kind/weight/evidence
            tooltip renders here. */}
        {hover !== null && hover.kind === "edge" && (
          <div
            className="nt-graph__tooltip"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
            role="tooltip"
          >
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
          </div>
        )}
        {/* The loading overlay covers the stage between "topology projected"
            and "first pixels" — engine init + warmup at 7.4k nodes used to
            leave a blank canvas here for seconds (owner 2026-10-14: a loading
            modal, not a blank view). It never renders for cached workspaces:
            the pre-paint paints synchronously in the lifecycle effect and
            clears the flag before the browser composites. */}
        {awaitingFirstFrame && (
          <div className="nt-graph__stage-loading">
            <LoadingScreen fullscreen={false} label="Warming up the layout…" />
          </div>
        )}
      </div>
      )}
      {rail}
      </div>
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
