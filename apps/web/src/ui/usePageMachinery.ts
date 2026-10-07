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
 * - the fold chords (Ctrl+. / Ctrl+Alt+arrows) on the focused block.
 *
 * The drag half (sensors, dropLine/dragging/moveError state, the four
 * dnd-kit handlers) lives at the workspace host now — one drag session for
 * the whole workspace (useWorkspaceDnd.ts); a surface joins it as a zone
 * with the facts this hook still owns (pageRootRef + the outliner's
 * positions), so the machinery exposes them but no longer wires any DnD.
 *
 * Options: `globalShortcuts` (default true) gates the document-level
 * listeners (find/replace chord, fold chords) — the main surface passes
 * true; secondary surfaces (workspace cards) pass false; embedded
 * renders imply false. Nothing here renders — pure hooks + callbacks.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, WorkspaceClient } from "@/core/workspace-client.js";
import { proseFromAst } from "@/editor/prose.js";

import { ensureTemplateFamily } from "./components/templateFamily.js";
import { replaceRangeInAst } from "./editor-popups/block-find-replace.js";
import { useOutlinerValue } from "./outliner-context.js";
import { useBlockSelectionSurface } from "./use-block-selection.js";

export interface UsePageMachineryOptions {
  client: WorkspaceClient | WorkerClient;
  pageId: string;
  /** The block tree (the component's own read — feeds find docs). */
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
  /** Page root: find/replace highlights blocks inside it. */
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
  };
}
