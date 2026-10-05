/**
 * PageView — a page inside the floating content card: the ancestor
 * breadcrumbs, the page header (icon + editable title + view toggles), the
 * collapsible Metadata section, the recursive block tree of the page's
 * children + the "add block" affordance for an empty page, then (after a
 * divider) the system sections (linked references — expanded, child pages
 * and unlinked references — collapsed) per SCHEMA.md's lazy-loading
 * contract. Reads from a client (in-process WorkspaceClient or the
 * WorkerClient proxy — same surface) and re-renders on its (naive)
 * notifications.
 *
 * PageView also owns the OutlinerContext: the write surface, the per-render
 * outline position map (sibling/parent facts for Tab/Backspace), the focus
 * request that hands the caret between blocks after structural gestures, and
 * the session-local view transforms: subtree collapse (a Set of hidden node
 * ids, display-only) and prose mode (the `nt-prose` class on the tree).
 *
 * Editor chrome owned here: the find & replace widget (Ctrl/Cmd+Shift+F)
 * searching the block tree's prose projection, and the page-level
 * LinkEditModal host — read-mode clicks on external_link chips open the
 * modal, and the editor's slash "Add URL" flow opens it through the same
 * opener (see editor-popups/).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { DndContext, DragOverlay, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { rendersWithDocumentChrome, parseDateNodeId, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, ClientNode, WorkspaceClient } from "@/core/workspace-client.js";
import { proseFromAst } from "@/editor/prose.js";

import { ExportPageModal } from "./components/modals/ExportPageModal.js";
import { SharePageModal } from "./components/modals/SharePageModal.js";
import type { ShareTarget } from "./components/NodeMenuButton.js";
import { NodeContextMenu } from "./components/NodeContextMenu.js";
import { DayFlags, DayPageDateBar } from "./components/DayPageDateBar.js";
import { DayPageSections } from "./components/DayPageSections.js";
import { isoOfDateParts } from "./components/calendarViewUtils.js";
import { nodeIcon } from "./iconFor.js";
import { displayNameForSettings, displayNameFromClient } from "./dateDisplay.js";

import {
  DropLineContext,
  blockCollisionDetection,
  dropLineFromDragEvent,
  dropZoneOf,
  executeMove,
  executeMoveFromClient,
  moveErrorMessage,
  resolveMove,
  resolveMoveFromClient,
  useBlockDndSensors,
  type DropLine,
} from "./block-dnd.js";
import { PropertiesSection, ClassesRow, TagsRow } from "./components/MetadataSection.js";
import { IconPickerPopup } from "./components/IconPickerPopup.js";
import { CoverCard } from "./components/PageBanner.js";
import { PageFooter } from "./components/PageFooter.js";
import { SelectionBar } from "./components/SelectionBar.js";
import { SystemSections } from "./components/SystemSections.js";
import { canHaveCoverOf, coverAssetIdOf, ensureCoverProperty } from "./components/coverProperty.js";
import { ensureAliasOfProperty, ensureAliasProperty } from "./components/aliasProperty.js";
import { AliasOfBanner } from "./components/AliasOfBanner.js";
import { EmbedBoundary } from "./EmbedView.js";
import { Icon } from "./Icon.js";
import { TitleEditor } from "./TitleEditor.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { OutlinerContext, useOutlinerValue } from "./outliner-context.js";
import { useBlockSelectionSurface } from "./use-block-selection.js";
import { NodeCollection, ViewToolbar } from "./views/index.js";
import type { NodeCollectionItem, ViewMode } from "./views/index.js";
import { useViewModePreference } from "./viewPrefs.js";
import { FindReplaceWidget } from "./editor-popups/FindReplaceWidget.js";
import {
  LinkEditModalHost,
  type LinkEditModalOpener,
} from "./editor-popups/LinkEditModal.js";
import { replaceRangeInAst } from "./editor-popups/block-find-replace.js";
import { ensureTemplateFamily } from "./components/templateFamily.js";

/** The child-blocks triad, in switcher order. */
const BLOCKS_VIEW_MODES: ViewMode[] = ["outline", "prose", "cards"];

/** BlockTreeNode → the collection input shape (recursive). */
function toCollectionItem(entry: BlockTreeNode): NodeCollectionItem {
  return { node: entry.node, children: entry.children.map(toCollectionItem) };
}

export function PageView({
  client,
  pageId,
  onOpenPage,
  onOpenInSidebar,
  onDeleted,
  onPresent,
  embedded = false,
  /**
   * Class composition (the Class View renders a class node through PageView):
   * accepts a class node in the page read (getPage excludes classes), adds
   * `rootClassName` to the `.nt-page` root, and enables the slots below. All
   * slots default to the plain-page chrome.
   */
  forClass = false,
  rootClassName = undefined,
  /** Replaces the default classes corner cluster (ClassView: extends pills). */
  corner = undefined,
  /** Replaces the default header icon button + picker (ClassView: curated). */
  iconButton = undefined,
  /** Right-aligned extras in the title row (ClassView: the class color dot). */
  headerActions = undefined,
  /** Rendered right after the header (ClassView: the extends-cycle banner). */
  notice = undefined,
  /** Inserted between the block tree and the system sections (class sections). */
  sections = undefined,
  /** Replaces the default <SystemSections/> (ClassView: extends-by + system). */
  systemSections = undefined,
  /** §34.62 shares: server coordinates for the "Share…" item + modal. */
  shareTarget = undefined,
}: {
  client: WorkspaceClient | WorkerClient;
  pageId: string;
  /** Page navigation (child-pages rows, reference crumbs). */
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** Shift+click peek target: open the node as a card in the right sidebar. */
  onOpenInSidebar?: ((nodeId: string) => void) | undefined;
  /** Post-delete navigation (host routes to the parent / default view). */
  onDeleted?: ((node: ClientNode) => void) | undefined;
  /** Presentation mode (§34.26): "Present" decks this page's subtree read-only. */
  onPresent?: ((pageId: string) => void) | undefined;
  /**
   * Embedded mode (journals feed): the title renders as a static button that
   * navigates to the full page view instead of the inline TitleEditor, and
   * the page-level find/replace shortcut stays off so stacked feeds don't
   * install one document listener per entry.
   */
  embedded?: boolean;
  forClass?: boolean;
  rootClassName?: string | undefined;
  corner?: ReactNode;
  iconButton?: ReactNode;
  headerActions?: ReactNode;
  notice?: ReactNode;
  sections?: ReactNode;
  systemSections?: ReactNode;
  shareTarget?: ShareTarget | undefined;
}) {
  /**
   * Child-blocks view mode (the outline/prose/cards triad): durable display
   * state per page (§34.27 L1) — device-local, never an op. Unset/stale
   * values fall back to outline, the surface default.
   */
  const [blocksMode, setBlocksMode] = useViewModePreference(
    `nodeBlocks.${pageId}`,
    "outline",
    BLOCKS_VIEW_MODES,
  );
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  /** Icon picker popup anchor + open state (clicking the page icon). */
  const pageIconRef = useRef<HTMLElement | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [exporting, setExporting] = useState<{ pageId: string; name: string } | null>(null);
  const [sharing, setSharing] = useState<{ pageId: string; name: string } | null>(null);
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  /**
   * View transforms (SCHEMA.md: display state, never content). Collapse is a
   * per-session set of hidden subtree roots; prose mode flattens bullets and
   * indents via the `nt-prose` class. Neither is persisted in this slice.
   * (Collapse state itself lives in the OutlinerContext value, see the hook.)
   */

  // --- editor chrome: find & replace + link edit modal -----------------------

  /** Page root: find/replace highlights blocks inside it; link clicks delegate. */
  const pageRootRef = useRef<HTMLDivElement>(null);
  /** The block-tree selection surface (multi-selection gestures). */
  const selectionRootRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  /** The LinkEditModal opener, published by the host below (context lives a level down). */
  const linkOpenerRef = useRef<LinkEditModalOpener | null>(null);

  // Ctrl/Cmd+Shift+F opens the find & replace widget (page view only —
  // embedded journal entries skip it so feeds don't stack document listeners).
  useEffect(() => {
    if (embedded) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [embedded]);

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
  useEffect(() => {
    if (moveError === null) return;
    const timer = setTimeout(() => setMoveError(null), 4000);
    return () => clearTimeout(timer);
  }, [moveError]);

  // The page read accepts a class node only in class composition (getPage
  // excludes classes by design — rendersWithDocumentChrome is the page test).
  const rawNode = client.getNode(pageId);
  const page =
    rawNode !== undefined &&
    (rendersWithDocumentChrome(rawNode) || (forClass && rawNode.isClass))
      ? rawNode
      : undefined;
  const headerIcon =
    page !== undefined ? nodeIcon(page, client.classIcons()) : null;
  const tree = page !== undefined ? client.getBlockTree(pageId) : [];
  /** The same tree in the view system's input shape (session view state). */
  const blockItems: NodeCollectionItem[] = tree.map(toCollectionItem);
  /**
   * §34.28 #4/#7 — the day branch: a node whose id parses at day precision
   * is a day page and gets the date bar (±1 day stepping over the
   * deterministic ids + the reviewed toggle) and the three aggregation
   * sections. Embedded renders (journal feed, calendar daily-note embed)
   * skip both — they already sit on aggregation surfaces.
   */
  const parsedDay = page !== undefined ? parseDateNodeId(pageId) : null;
  const dayIso =
    parsedDay !== null && parsedDay.precision === "day" ? isoOfDateParts(parsedDay) : null;

  // Fullscreen whiteboard (SCHEMA.md: a whiteboard page carries a
  // `whiteboard` content token — the whiteboard CLASS, not any node kind,
  // says so): the spatial canvas renders IN PLACE OF the outline tree — the
  // children are the cards. The whiteboard CLASS is identity too (owner
  // ruling): a node classed `whiteboard` whose content carries no token yet
  // still opens in whiteboard mode — the token is authored lazily on open.
  const whiteboardTokenIndex = page?.contentAst.findIndex(
    (token) =>
      typeof token === "object" && token !== null &&
      (token as { type?: unknown }).type === "whiteboard",
  ) ?? -1;
  const whiteboardClassed =
    page !== undefined && page.classIds.includes(SYSTEM_CLASS_UUIDS.whiteboard);
  useEffect(() => {
    if (
      page === undefined ||
      embedded ||
      whiteboardTokenIndex >= 0 ||
      !whiteboardClassed
    ) {
      return;
    }
    void client.updateObject(page.id, {
      contentAst: [...page.contentAst, { type: "whiteboard", layout: { cards: {}, shapes: [], strokes: [] } }],
    });
  }, [client, page, embedded, whiteboardTokenIndex, whiteboardClassed]);

  /**
   * Cover property self-heal (§34.27 L2): the cover schema + source binding
   * are seed-manifest entries nothing else authors (the v1 migration is the
   * only other writer), so a fresh workspace self-heals them on first page
   * view — an idempotent no-op once present. The banner below then reads
   * the effective cover value; pages without one (date pages, whiteboard
   * pages, everything not classed `source`) render no banner at all.
   */
  useEffect(() => {
    void ensureCoverProperty(client);
  }, [client]);

  /**
   * Alias property self-heal (§34.32 PG10 + issue #7): the seeded
   * multi-value `alias` text schema and the seeded single-value node-typed
   * `aliasOf` schema (global scope, no class bindings) are authored
   * idempotently on first page view — the server seed only runs on an
   * empty workspace, so existing workspaces would never see them otherwise
   * (the ensureCoverProperty precedent).
   */
  useEffect(() => {
    void ensureAliasProperty(client);
    void ensureAliasOfProperty(client);
  }, [client]);

  /** The cover's asset target, when the page carries the property. */
  const coverAssetId =
    page !== undefined && !embedded && whiteboardTokenIndex < 0
      ? coverAssetIdOf(client, pageId)
      : null;
  /** §34.72: the v1 element renders whenever the page can carry a cover —
   *  set or empty (the card shows the Add affordance when empty). */
  const coverPossible =
    page !== undefined && !embedded && whiteboardTokenIndex < 0
      ? canHaveCoverOf(client, pageId)
      : false;

  const outliner = useOutlinerValue(client, pageId, {
    // Render-cascade navigation for query result lists (App routes the id).
    openNode: (id) => onOpenPage?.(id),
    openInSidebar: (id) => onOpenInSidebar?.(id),
    // §34.25 T3: the slash template flow self-heals the template family
    // before instantiating (idempotent no-op once present).
    ensureTemplateFamily: () => ensureTemplateFamily(client),
    // §34.19 block multi-selection: the main page body is a selection
    // surface; embedded feed entries and class composition aren't.
    selection: !embedded && !forClass,
  });
  const positions = outliner.positions;
  const outlinerRef = useRef(outliner);
  outlinerRef.current = outliner;

  // Ctrl+. (toggle) / Ctrl+Alt+← (fold) / Ctrl+Alt+→ (unfold) — the §34.19
  // fold chords on the FOCUSED block (the row is discovered from the active
  // element — the editor stays the focus owner, no focus ledger). Alt+←/→
  // belongs to Back/Forward (the App keymap), so fold moved to the Ctrl+Alt+
  // arrow pair (free in Chrome/Firefox/Safari; some OS display drivers rotate
  // the screen on it — out of the page's reach, same as v1's fate with
  // Alt+arrows in browsers).
  useEffect(() => {
    if (embedded) return;
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
  }, [embedded]);

  // --- §34.19 block multi-selection ------------------------------------------
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
  };

  const handleDragMove = (event: DragMoveEvent) => {
    setDropLine(dropLineFromDragEvent(event, positions));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const line = dropLineFromDragEvent(event, positions);
    const activeId = String(event.active.id);
    setDropLine(null);
    setDragging(null);
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
    setDropLine(null);
    setDragging(null);
  };

  if (!page) {
    return <div className="nt-page-missing">Page not found.</div>;
  }

  /**
   * §34.19 ghost trailing block (owner refinement): rendered ALWAYS in the
   * child-blocks section (outline, non-embedded) — including an empty body —
   * as the sole "add" affordance (the dedicated + Add button is gone). The
   * click creates a real empty block at the end and focuses it.
   */
  const ghostVisible = !embedded && blocksMode === "outline";
  const addTrailingBlock = async () => {
    const id = await client.createObject({ parentId: pageId, contentAst: [] });
    outliner.requestFocus(id, "start");
  };

  return (
    <OutlinerContext.Provider value={outliner}>
      <LinkEditModalHost client={client} openerRef={linkOpenerRef}>
        <div
          className={rootClassName !== undefined ? `nt-page ${rootClassName}` : "nt-page"}
          ref={pageRootRef}
          onClick={handleExternalLinkClick}
        >
          {/* Classes: pinned to the main content card's top-left corner
              (outside the centered content column), with card padding.
              Class composition swaps in its extends (parent-class) pills. */}
          {!embedded &&
            (corner !== undefined ? (
              corner
            ) : (
              <div className="nt-page-classes-corner">
                <ClassesRow client={client} nodeId={pageId} classIds={page.classIds} onOpenPage={onOpenPage} />
              </div>
            ))}
          {findOpen && (
            <FindReplaceWidget
              blocks={findDocs}
              highlightRootRef={pageRootRef}
              onReplace={handleFindReplace}
              onClose={() => setFindOpen(false)}
            />
          )}
          {/* §34.72 — the v1 header layout: header left, the collapsible
              cover CARD right (always rendered when the page can carry a
              cover, even empty). */}
          <div className="page-header-section">
          <header className="nt-page-header">
          <div className="page-header__title-row">
            {iconButton !== undefined ? (
              iconButton
            ) : (
              <>
                <span
                  className="page-icon-btn"
                  title="Page icon (click: change icon)"
                  ref={pageIconRef}
                  onClick={() => {
                    if (!embedded) setIconPickerOpen((open) => !open);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setHeaderMenu({ x: event.clientX, y: event.clientY });
                  }}
                >
                  {headerIcon !== null ? (
                    <Icon path={headerIcon} size={1.4} className="page-icon-large" />
                  ) : (
                    <span className="page-icon-placeholder">◈</span>
                  )}
                </span>
                {iconPickerOpen && (
                  <IconPickerPopup
                    value={page.icon ?? undefined}
                    anchorEl={pageIconRef.current}
                    onSelect={(iconValue) => {
                      // "" clears (Icon treats empty as no icon).
                      void client.updateObject(pageId, { icon: iconValue });
                    }}
                    onClose={() => setIconPickerOpen(false)}
                  />
                )}
              </>
            )}
            {/* Right-click anywhere on the title (not just the icon) opens the
                page's node context menu — the browser menu is never the
                honest surface for a node. */}
            <span
              className="nt-page-title-wrap"
              onContextMenu={(event) => {
                event.preventDefault();
                setHeaderMenu({ x: event.clientX, y: event.clientY });
              }}
            >
            {embedded ? (
              <button
                type="button"
                className="nt-page-title-link"
                title="Open page"
                onClick={() => onOpenPage?.(pageId)}
              >
                {displayNameForSettings(page)}
              </button>
            ) : (
              <TitleEditor page={page} />
            )}
              {dayIso !== null && !embedded && <DayFlags iso={dayIso} />}
            </span>
            {!embedded && blocksMode !== undefined && (
              <div className="nt-blocks-bar" role="group" aria-label="Blocks view">
                <ViewToolbar
                  modes={BLOCKS_VIEW_MODES}
                  value={blocksMode}
                  onChange={setBlocksMode}
                />
              </div>
            )}
            {headerActions !== undefined && (
              <div className="nt-page-toolbar">{headerActions}</div>
            )}
          </div>
          {!embedded && (
            <TagsRow client={client} nodeId={pageId} tagIds={page.tagIds} onOpenPage={onOpenPage} />
          )}
        </header>
        {coverPossible && (
          <aside className="page-header-section__cover">
            <CoverCard client={client} pageId={pageId} assetId={coverAssetId} />
          </aside>
        )}
        </div>
        {dayIso !== null && !embedded && (
          <DayPageDateBar client={client} iso={dayIso} onOpenPage={onOpenPage} />
        )}
        {notice}
        {moveError !== null && (
          <div role="alert" className="nt-dnd-error">
            {moveError}
          </div>
        )}
        {/* Issue #7 — an alias page names its main page and jumps to it;
            null for every ordinary page. */}
        {!embedded && (
          <AliasOfBanner client={client} aliasPageId={pageId} onOpenPage={onOpenPage} />
        )}
        <PropertiesSection client={client} nodeId={pageId} onOpenPage={onOpenPage} />
        <div className="nt-metadata-divider" />
        {whiteboardTokenIndex >= 0 || (whiteboardClassed && !embedded) ? (
          whiteboardTokenIndex >= 0 ? (
            <>
              <WhiteboardCanvas client={client} hostId={pageId} tokenIndex={whiteboardTokenIndex} />
              {systemSections ?? (
                <SystemSections client={client} pageId={pageId} onOpenPage={onOpenPage} withActivity={!embedded} />
              )}
            </>
          ) : (
            // Classed whiteboard without the token yet: the open effect is
            // authoring it — one bare frame, then the canvas mounts.
            <div className="nt-whiteboard-boot" aria-label="Opening whiteboard…" />
          )
        ) : (
          <>
            <EmbedBoundary rootId={pageId}>
              <DndContext
                sensors={sensors}
                collisionDetection={blockCollisionDetection}
                onDragStart={handleDragStart}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
              >
                <DropLineContext.Provider value={dropLine}>
                  <SortableContext items={tree.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
                    <div
                      ref={selectionRootRef}
                      className="nt-select-surface"
                      onMouseDownCapture={selectionSurface.onMouseDownCapture}
                    >
                      <NodeCollection
                        viewMode={blocksMode}
                        client={client}
                        items={blockItems}
                        tree
                        editable
                        onNodeClick={(id) => onOpenPage?.(id)}
                        onNodeShiftClick={(id) => onOpenInSidebar?.(id)}
                      />
                      {/* §34.19 ghost trailing block: a body whose last child
                          is non-empty offers a muted "click to add" row —
                          display-only until the click, which creates a real
                          empty block and focuses it (never an op by itself).
                          Outline mode only (prose/cards aren't block lists);
                          an already-empty last child keeps the affordance
                          redundant, so it hides. */}
                      {ghostVisible && (
                        <button
                          type="button"
                          className="nt-ghost-block"
                          onClick={() => void addTrailingBlock()}
                        >
                          Click to add a block
                        </button>
                      )}
                    </div>
                  </SortableContext>
                  {/* The system sections join the same drag context: the Child
                      pages section's read-only rows are droppable (zone-aware —
                      a drop anchored on a main child promotes into the Pages
                      zone, see handleDragEnd). Class composition inserts its
                      class-relevant sections ahead of them. */}
                  {sections}
                  {dayIso !== null && !embedded && (
                    <DayPageSections
                      client={client}
                      pageId={pageId}
                      iso={dayIso}
                      onOpenPage={onOpenPage}
                    />
                  )}
                  {systemSections ?? (
                    <SystemSections client={client} pageId={pageId} onOpenPage={onOpenPage} withActivity={!embedded} />
                  )}
                </DropLineContext.Provider>
                <DragOverlay dropAnimation={null}>
                  {dragging !== null && <div className="nt-drag-ghost">{dragging.label}</div>}
                </DragOverlay>
              </DndContext>
            </EmbedBoundary>
          </>
        )}
        {!embedded && (
          <PageFooter client={client} page={page} tree={tree} onOpenNode={onOpenPage} />
        )}
        </div>
        <NodeContextMenu
          state={
            headerMenu === null
              ? null
              : { ...headerMenu, node: page, isPage: true }
          }
          client={client}
          onClose={() => setHeaderMenu(null)}
          onOpenNode={(id) => {
            setHeaderMenu(null);
            onOpenPage?.(id);
          }}
          onPresent={onPresent}
          onExport={(id, name) => {
            setHeaderMenu(null);
            setExporting({ pageId: id, name });
          }}
          onShare={
            shareTarget === undefined
              ? undefined
              : (id, name) => {
                  setHeaderMenu(null);
                  setSharing({ pageId: id, name });
                }
          }
          onDeleted={(node) => {
            setHeaderMenu(null);
            onDeleted?.(node);
          }}
        />
        {/* §34.19 block multi-selection: the floating group-ops bar rides
            the page chrome while a selection is live. */}
        {outliner.selectionEnabled && <SelectionBar client={client} />}
        {exporting !== null && (
          <ExportPageModal
            isOpen
            client={client}
            nodeUuid={exporting.pageId}
            nodeName={exporting.name}
            onClose={() => setExporting(null)}
          />
        )}
        {sharing !== null && shareTarget !== undefined && (
          <SharePageModal
            isOpen
            serverUrl={shareTarget.serverUrl}
            token={shareTarget.credential}
            nodeUuid={sharing.pageId}
            nodeName={sharing.name}
            onClose={() => setSharing(null)}
          />
        )}
      </LinkEditModalHost>
    </OutlinerContext.Provider>
  );
}
