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

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { DndContext, DragOverlay, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, WorkspaceClient } from "@/core/workspace-client.js";
import { proseFromAst } from "@/editor/prose.js";

import { ExportPageModal } from "./components/modals/ExportPageModal.js";
import { NodeContextMenu } from "./components/NodeContextMenu.js";
import { classIconMap, nodeIcon } from "./iconFor.js";
import { displayNameForSettings, displayNameFromClient } from "./dateDisplay.js";

import { BlockRow } from "./BlockRow.js";
import {
  DropLineContext,
  blockCollisionDetection,
  dropLineFromDragEvent,
  executeMove,
  executeMoveFromClient,
  moveErrorMessage,
  resolveMove,
  resolveMoveFromClient,
  useBlockDndSensors,
  type DropLine,
} from "./block-dnd.js";
import { MetadataSection } from "./components/MetadataSection.js";
import { SystemSections } from "./components/SystemSections.js";
import { EmbedBoundary } from "./EmbedView.js";
import { Icon } from "./Icon.js";
import { TitleEditor } from "./TitleEditor.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { OutlinerContext, useOutlinerValue } from "./outliner-context.js";
import { FindReplaceWidget } from "./editor-popups/FindReplaceWidget.js";
import {
  LinkEditModalHost,
  type LinkEditModalOpener,
} from "./editor-popups/LinkEditModal.js";
import { replaceRangeInAst } from "./editor-popups/block-find-replace.js";

export function PageView({
  client,
  pageId,
  onOpenPage,
  embedded = false,
}: {
  client: WorkspaceClient | WorkerClient;
  pageId: string;
  /** Page navigation (child-pages rows, reference crumbs). */
  onOpenPage?: ((pageId: string) => void) | undefined;
  /**
   * Embedded mode (journals feed): the title renders as a static button that
   * navigates to the full page view instead of the inline TitleEditor, and
   * the page-level find/replace shortcut stays off so stacked feeds don't
   * install one document listener per entry.
   */
  embedded?: boolean;
}) {
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const [exporting, setExporting] = useState<{ pageId: string; name: string } | null>(null);
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

  const page = client.getPage(pageId);
  const headerIcon =
    page !== undefined ? nodeIcon(page, classIconMap(client.listClasses())) : null;
  const tree = page !== undefined ? client.getBlockTree(pageId) : [];

  // Fullscreen whiteboard (SCHEMA.md: a whiteboard page is node_type='page'
  // with a `whiteboard` content token): the spatial canvas renders IN PLACE
  // OF the outline tree — the children are the cards.
  const whiteboardTokenIndex = page?.contentAst.findIndex(
    (token) =>
      typeof token === "object" && token !== null &&
      (token as { type?: unknown }).type === "whiteboard",
  ) ?? -1;

  const outliner = useOutlinerValue(client, pageId, {
    // f(node_type) navigation for query result lists (App routes the id).
    openNode: (id) => onOpenPage?.(id),
  });
  const positions = outliner.positions;

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
      // reference / embed): resolve the drop straight from the client.
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

  const addFirstBlock = async () => {
    const id = await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [],
    });
    outliner.requestFocus(id, "start");
  };

  return (
    <OutlinerContext.Provider value={outliner}>
      <LinkEditModalHost client={client} openerRef={linkOpenerRef}>
        <div className="nt-page" ref={pageRootRef} onClick={handleExternalLinkClick}>
          {findOpen && (
            <FindReplaceWidget
              blocks={findDocs}
              highlightRootRef={pageRootRef}
              onReplace={handleFindReplace}
              onClose={() => setFindOpen(false)}
            />
          )}
          <header className="nt-page-header">
          <div className="page-header__title-row">
            <span
              className="page-icon-btn"
              title="Page icon"
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
          </div>
        </header>
        {moveError !== null && (
          <div role="alert" className="nt-dnd-error">
            {moveError}
          </div>
        )}
        <MetadataSection client={client} nodeId={pageId} onOpenPage={onOpenPage} />
        <div className="nt-metadata-divider" />
        {whiteboardTokenIndex >= 0 ? (
          <WhiteboardCanvas client={client} hostId={pageId} tokenIndex={whiteboardTokenIndex} />
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
                <div className="nt-block-tree">
                  {tree.map((child) => (
                    <BlockRow key={child.node.id} tree={child} client={client} resolveName={(id) => displayNameFromClient(client, id)} />
                  ))}
                </div>
              </SortableContext>
            </DropLineContext.Provider>
            <DragOverlay dropAnimation={null}>
              {dragging !== null && <div className="nt-drag-ghost">{dragging.label}</div>}
            </DragOverlay>
          </DndContext>
            </EmbedBoundary>
            {tree.length === 0 && (
              <button type="button" className="nt-add-block" onClick={() => void addFirstBlock()}>
                + Add a block
              </button>
            )}
          </>
        )}
        <SystemSections client={client} pageId={pageId} onOpenPage={onOpenPage} />
        </div>
      </LinkEditModalHost>
    </OutlinerContext.Provider>
  );
}
