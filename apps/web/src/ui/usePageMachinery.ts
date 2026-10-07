/**
 * usePageMachinery — everything PageView wired by hand for its editing
 * surface, in one hook (the main-content restructure: the carve that
 * keeps NodeView a thin composer — the machinery bag moves out of the
 * component; the JSX that hosts it stays). Per-surface remainder:
 *
 * - outliner construction (`useOutlinerValue` + the ref mirror for keyboard
 *   chords) with the component's navigation/template/selection options,
 * - the selection surface (`useBlockSelectionSurface`),
 * - find/replace state + the shortcut listener + the prose docs,
 * - the external-link delegation + the LinkEditModal opener ref,
 * - the DnD wiring (sensors, dropLine/dragging/moveError state, the four
 *   dnd-kit handlers) — moved as it exists today; a later slice hoists the
 *   drag half to the workspace host (`useWorkspaceDnd`),
 * - the fold chords (Ctrl+. / Ctrl+Alt+arrows) on the focused block.
 *
 * Options: `globalShortcuts` (default true) gates the document-level
 * listeners (find/replace chord, fold chords) — the main surface passes
 * true; secondary surfaces (workspace cards) pass false; embedded
 * renders imply false. Nothing here renders — pure hooks + callbacks.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import type { DragEndEvent, DragMoveEvent, DragStartEvent } from "@dnd-kit/core";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, WorkspaceClient } from "@/core/workspace-client.js";
import { proseFromAst } from "@/editor/prose.js";

import {
  dragPointerOf,
  dropCandidatesOf,
  dropLineFromDragEvent,
  dropZoneOf,
  executeMove,
  executeMoveFromClient,
  measureDragRows,
  moveErrorMessage,
  nearestCandidate,
  resolveMove,
  resolveMoveFromClient,
  useBlockDndSensors,
  type DropCandidate,
  type DropLine,
} from "./block-dnd.js";
import { ensureTemplateFamily } from "./components/templateFamily.js";
import { displayNameFromClient } from "./dateDisplay.js";
import { replaceRangeInAst } from "./editor-popups/block-find-replace.js";
import type { LinkEditModalOpener } from "./editor-popups/LinkEditModal.js";
import { useOutlinerValue } from "./outliner-context.js";
import { useBlockSelectionSurface } from "./use-block-selection.js";

export interface UsePageMachineryOptions {
  client: WorkspaceClient | WorkerClient;
  pageId: string;
  /** The block tree (the component's own read — feeds find docs + DnD). */
  tree: BlockTreeNode[];
  embedded: boolean;
  forClass: boolean;
  focusMode: boolean;
  /** Surface-level global listeners (find/replace chord, fold chords). */
  globalShortcuts?: boolean;
  onOpenPage?: ((pageId: string) => void) | undefined;
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
}

export interface PageMachinery {
  /** Page root: find/replace highlights blocks inside it; link clicks delegate. */
  pageRootRef: React.RefObject<HTMLDivElement | null>;
  /** The block-tree selection surface (multi-selection gestures). */
  selectionRootRef: React.RefObject<HTMLDivElement | null>;
  outliner: ReturnType<typeof useOutlinerValue>;
  outlinerRef: React.RefObject<ReturnType<typeof useOutlinerValue>>;
  selectionSurface: ReturnType<typeof useBlockSelectionSurface>;
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
  findDocs: { id: string; prose: string }[];
  handleFindReplace: (blockId: string, start: number, end: number, text: string) => void;
  handleExternalLinkClick: (event: MouseEvent<HTMLDivElement>) => void;
  linkOpenerRef: React.RefObject<LinkEditModalOpener | null>;
  dnd: {
    sensors: ReturnType<typeof useBlockDndSensors>;
    dropLine: DropLine | null;
    dragging: { id: string; label: string } | null;
    moveError: string | null;
    handleDragStart: (event: DragStartEvent) => void;
    handleDragMove: (event: DragMoveEvent) => void;
    handleDragEnd: (event: DragEndEvent) => void;
    handleDragCancel: () => void;
  };
}

export function usePageMachinery({
  client,
  pageId,
  tree,
  embedded,
  forClass,
  focusMode,
  globalShortcuts = true,
  onOpenPage,
  onOpenInSidebar,
}: UsePageMachineryOptions): PageMachinery {
  const shortcuts = globalShortcuts && !embedded;
  const pageRootRef = useRef<HTMLDivElement>(null);
  const selectionRootRef = useRef<HTMLDivElement>(null);
  const linkOpenerRef = useRef<LinkEditModalOpener | null>(null);

  const [findOpen, setFindOpen] = useState(false);

  // Ctrl/Cmd+Shift+F opens the find & replace widget (main surface only —
  // embedded feeds skip it so stacked surfaces don't install one document
  // listener per entry).
  useEffect(() => {
    if (!shortcuts) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [shortcuts]);

  const handleFindReplace = useCallback(
    (blockId: string, start: number, end: number, text: string) => {
      const block = client.getNode(blockId);
      if (block === undefined) return;
      void client.updateObject(blockId, {
        contentAst: replaceRangeInAst(block.contentAst, start, end, text),
      });
    },
    [client],
  );

  /**
   * Read-mode clicks on an external_link chip open the LinkEditModal for
   * that token (the anchor's default navigation is suppressed only when the
   * token resolves). The slash "Add URL" flow reaches the same modal through
   * the opener while editing.
   */
  const handleExternalLinkClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a.nt-external-link");
    if (anchor === null) return;
    const blockId = anchor.closest("[data-block-id]")?.getAttribute("data-block-id");
    if (blockId === null || blockId === undefined) return;
    const block = client.getNode(blockId);
    if (block === undefined) return;
    const href = anchor.getAttribute("href") ?? "";
    const text = anchor.textContent ?? "";
    const tokenIndex = block.contentAst.findIndex(
      (token) =>
        (token as { type?: string }).type === "external_link" &&
        (token as { href?: string }).href === href &&
        (token as { text?: string }).text === text,
    );
    if (tokenIndex < 0) return;
    event.preventDefault();
    linkOpenerRef.current?.({
      kind: "external",
      blockId,
      tokenIndex,
      insertAt: null,
      initialUrl: href,
      initialLabel: text,
    });
  };

  // --- drag-and-drop reordering (block-dnd.ts intent model) -------------------
  const sensors = useBlockDndSensors();
  const [dropLine, setDropLine] = useState<DropLine | null>(null);
  const [dragging, setDragging] = useState<{ id: string; label: string } | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // The drag session's valid-location set: the visible rows measured once at
  // drag start, projected against on every pointer move (proximity snapping).
  const dragCandidatesRef = useRef<DropCandidate[] | null>(null);
  useEffect(() => {
    if (moveError === null) return;
    const timer = setTimeout(() => setMoveError(null), 4000);
    return () => clearTimeout(timer);
  }, [moveError]);

  const outliner = useOutlinerValue(client, pageId, {
    // Render-cascade navigation for query result lists (App routes the id).
    openNode: (id) => onOpenPage?.(id),
    openInSidebar: (id) => onOpenInSidebar?.(id),
    // The slash template flow self-heals the template family before
    // instantiating (idempotent no-op once present).
    ensureTemplateFamily: () => ensureTemplateFamily(client),
    // Block multi-selection: the main page body is a selection surface;
    // embedded feed entries and class composition aren't.
    selection: !embedded && !forClass,
    // Focus mode: block rows hide their reference/property chrome.
    focusMode,
  });
  const positions = outliner.positions;
  const outlinerRef = useRef(outliner);
  outlinerRef.current = outliner;

  // Ctrl+. (toggle) / Ctrl+Alt+← (fold) / Ctrl+Alt+→ (unfold) — the fold
  // chords on the FOCUSED block (the row is discovered from the active
  // element — the editor stays the focus owner, no focus ledger). Alt+←/→
  // belongs to Back/Forward (the App keymap), so fold moved to the Ctrl+Alt+
  // arrow pair (free in Chrome/Firefox/Safari; some OS display drivers rotate
  // the screen on it — out of the page's reach, same as the original's fate with
  // Alt+arrows in browsers).
  useEffect(() => {
    if (!shortcuts) return;
    const handler = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key;
      const toggle = !event.altKey && !event.shiftKey && key === ".";
      const fold = event.altKey && !event.shiftKey && key === "ArrowLeft";
      const unfold = event.altKey && !event.shiftKey && key === "ArrowRight";
      if (!toggle && !fold && !unfold) return;
      const root = pageRootRef.current;
      const active = document.activeElement;
      if (root === null || !(active instanceof Element) || !root.contains(active)) return;
      const blockId = active.closest("[data-block-id]")?.getAttribute("data-block-id");
      if (blockId === null || blockId === undefined) return;
      if (outlinerRef.current.client.getChildren(blockId).length === 0) return;
      event.preventDefault();
      const collapsed = outlinerRef.current.collapsed.has(blockId);
      if (fold) {
        if (!collapsed) outlinerRef.current.toggleCollapse(blockId);
      } else if (unfold) {
        if (collapsed) outlinerRef.current.toggleCollapse(blockId);
      } else {
        outlinerRef.current.toggleCollapse(blockId);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [shortcuts]);

  // --- block multi-selection ------------------------------------------
  const selectionSurface = useBlockSelectionSurface(
    outliner,
    selectionRootRef,
    !embedded && !forClass,
  );

  /** Searchable documents: one prose projection per block in the tree. */
  const findDocs = useMemo(() => {
    const docs: { id: string; prose: string }[] = [];
    const walk = (nodes: BlockTreeNode[]) => {
      for (const entry of nodes) {
        docs.push({ id: entry.node.id, prose: proseFromAst(entry.node.contentAst) });
        walk(entry.children);
      }
    };
    walk(tree);
    return docs;
  }, [tree]);

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setDragging({ id, label: displayNameFromClient(client, id) ?? id });
    setMoveError(null);
    dragCandidatesRef.current = dropCandidatesOf(positions, id, measureDragRows(pageRootRef.current));
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const session = dragCandidatesRef.current;
    const pointer = dragPointerOf(event);
    if (session === null || pointer === null) {
      // Keyboard drags (no pointer) keep the event-driven indicator.
      setDropLine(dropLineFromDragEvent(event, positions));
      return;
    }
    const candidate = nearestCandidate(pointer, session);
    setDropLine(candidate === null ? null : { targetId: candidate.targetId, intent: candidate.intent });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const session = dragCandidatesRef.current;
    dragCandidatesRef.current = null;
    setDropLine(null);
    setDragging(null);
    // Pointer sessions resolve through the snap model; when nothing is near
    // (no indicator was showing), the event-driven line still resolves the
    // drop so guard refusals surface their banner exactly as before.
    // Keyboard drags have no pointer and always take the event-driven path.
    const pointer = dragPointerOf(event);
    const snapped =
      session !== null && pointer !== null ? nearestCandidate(pointer, session) : null;
    const line: DropLine | null =
      snapped !== null
        ? { targetId: snapped.targetId, intent: snapped.intent }
        : dropLineFromDragEvent(event, positions);
    if (line === null) return;
    let resolution = resolveMove({ activeId, line, positions });
    let crossTree = false;
    if (resolution.status === "noop" && positions.get(line.targetId) === undefined) {
      // The target row lives outside the page's own tree (a linked
      // reference / embed / a main-children section row): resolve the drop
      // straight from the client.
      resolution = resolveMoveFromClient({ activeId, line, client });
      crossTree = resolution.status === "move";
    }
    if (resolution.status === "noop") return;
    if (resolution.status === "refused") {
      setMoveError(resolution.reason);
      return;
    }
    void (async () => {
      try {
        const moveObject = (id: string, parentId: string | null, afterId?: string) =>
          afterId === undefined
            ? client.moveObject(id, parentId)
            : client.moveObject(id, parentId, afterId);
        if (crossTree) {
          await executeMoveFromClient({ activeId, command: resolution.command, client, moveObject });
        } else {
          await executeMove({ activeId, command: resolution.command, positions, moveObject });
        }
        // Zone-aware render bit: a drop anchored on a main-children row
        // promotes the dragged node into the Pages zone; a body-anchored
        // drop demotes it into the inline body. Only the flip issues an
        // update (matching the zone the node already has is a pure move).
        const zone = dropZoneOf(line, (id) => client.getNode(id));
        const dragged = client.getNode(activeId);
        if (dragged !== undefined && dragged.presentAsMain !== (zone === "main")) {
          await client.updateObject(activeId, { presentAsMain: zone === "main" });
        }
      } catch (err) {
        setMoveError(moveErrorMessage(err));
      }
    })();
  };

  const handleDragCancel = () => {
    dragCandidatesRef.current = null;
    setDropLine(null);
    setDragging(null);
  };

  return {
    pageRootRef,
    selectionRootRef,
    outliner,
    outlinerRef,
    selectionSurface,
    findOpen,
    setFindOpen,
    findDocs,
    handleFindReplace,
    handleExternalLinkClick,
    linkOpenerRef,
    dnd: {
      sensors,
      dropLine,
      dragging,
      moveError,
      handleDragStart,
      handleDragMove,
      handleDragEnd,
      handleDragCancel,
    },
  };
}
