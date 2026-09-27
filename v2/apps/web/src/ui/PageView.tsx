/**
 * PageView — a page: editable header title + the recursive block tree of
 * its children + the "add block" affordance for an empty page + the page's
 * system sections (linked references, unlinked references, child pages) per
 * SCHEMA.md: collapsed by default, no query until first expand. Reads from a
 * client (in-process WorkspaceClient or the WorkerClient proxy — same
 * surface) and re-renders on its (naive) notifications.
 *
 * PageView also owns the OutlinerContext: the write surface, the per-render
 * outline position map (sibling/parent facts for Tab/Backspace), the focus
 * request that hands the caret between blocks after structural gestures, and
 * the session-local view transforms: subtree collapse (a Set of hidden node
 * ids, display-only) and prose mode (the `nt-prose` class on the tree).
 */

import { useCallback, useEffect, useState } from "react";

import { DndContext, DragOverlay, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { deriveDisplayName } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ReferenceEntry, WorkspaceClient } from "@/core/workspace-client.js";

import { BlockRow } from "./BlockRow.js";
import {
  DropLineContext,
  blockCollisionDetection,
  dropLineFromDragEvent,
  executeMove,
  moveErrorMessage,
  resolveMove,
  useBlockDndSensors,
  type DropLine,
} from "./block-dnd.js";
import { EmbedBoundary } from "./EmbedView.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { Section } from "./Section.js";
import { TitleEditor } from "./TitleEditor.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { OutlinerContext, useOutlinerValue } from "./outliner-context.js";

/** One references row: containing-page breadcrumb, source excerpt, containment context. */
function ReferenceList({
  entries,
  onOpenPage,
}: {
  entries: ReferenceEntry[];
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  return (
    <ul className="nt-section-list">
      {entries.map((entry) => (
        <li key={entry.source.id}>
          <button
            type="button"
            className="nt-section-item"
            onClick={() => onOpenPage?.(entry.containingPageId)}
          >
            <span className="nt-section-crumb">{entry.containingPageName}</span>
            {entry.source.id !== entry.containingPageId && (
              <span className="nt-section-source">
                {" › "}
                {deriveDisplayName(entry.source) || entry.source.id}
              </span>
            )}
            {entry.kind === "containment" && (
              <span className="nt-section-context">in {entry.containingPageName}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PageView({
  client,
  pageId,
  onOpenPage,
}: {
  client: WorkspaceClient | WorkerClient;
  pageId: string;
  /** Page navigation (child-pages rows, reference crumbs). */
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  /**
   * View transforms (SCHEMA.md: display state, never content). Collapse is a
   * per-session set of hidden subtree roots; prose mode flattens bullets and
   * indents via the `nt-prose` class. Neither is persisted in this slice.
   * (Collapse state itself lives in the OutlinerContext value, see the hook.)
   */
  const [prose, setProse] = useState(false);

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

  // Section queries (SCHEMA.md lazy-loading contract): the closures are
  // created here but only INVOKED by Section after the first expand.
  const loadLinkedRefs = useCallback(() => client.getLinkedReferences(pageId), [client, pageId]);
  const loadUnlinkedRefs = useCallback(() => client.getUnlinkedReferences(pageId), [client, pageId]);
  const loadChildPages = useCallback(() => client.getChildPages(pageId), [client, pageId]);

  const page = client.getPage(pageId);
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

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setDragging({ id, label: client.getDisplayName(id) ?? id });
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
    const resolution = resolveMove({ activeId, line, positions });
    if (resolution.status === "noop") return;
    if (resolution.status === "refused") {
      setMoveError(resolution.reason);
      return;
    }
    void (async () => {
      try {
        await executeMove({
          activeId,
          command: resolution.command,
          positions,
          moveObject: (id, parentId, afterId) =>
            afterId === undefined
              ? client.moveObject(id, parentId)
              : client.moveObject(id, parentId, afterId),
        });
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
      <div className="nt-page">
        <header className="nt-page-header">
          <TitleEditor page={page} />
          <div className="nt-page-toolbar">
            <button
              type="button"
              className={prose ? "nt-view-toggle nt-view-toggle-active" : "nt-view-toggle"}
              aria-pressed={prose}
              onClick={() => setProse((p) => !p)}
            >
              Prose
            </button>
          </div>
        </header>
        {moveError !== null && (
          <div role="alert" className="nt-dnd-error">
            {moveError}
          </div>
        )}
        <PropertiesPanel client={client} nodeId={pageId} />
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
                <div className={prose ? "nt-block-tree nt-prose" : "nt-block-tree"}>
                  {tree.map((child) => (
                    <BlockRow key={child.node.id} tree={child} resolveName={(id) => client.getDisplayName(id)} />
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
        <div className="nt-page-sections">
          <Section
            key={`linked-${pageId}`}
            client={client}
            title="Linked references"
            badge={client.getBacklinkCount(pageId)}
            load={loadLinkedRefs}
            emptyText="No linked references."
            renderResults={(entries) => <ReferenceList entries={entries} onOpenPage={onOpenPage} />}
          />
          <Section
            key={`unlinked-${pageId}`}
            client={client}
            title="Unlinked references"
            load={loadUnlinkedRefs}
            emptyText="No unlinked references."
            renderResults={(entries) => <ReferenceList entries={entries} onOpenPage={onOpenPage} />}
          />
          <Section
            key={`child-${pageId}`}
            client={client}
            title="Child pages"
            badge={client.getChildPageCount(pageId)}
            load={loadChildPages}
            emptyText="No child pages."
            renderResults={(pages) => (
              <ul className="nt-section-list">
                {pages.map((child) => (
                  <li key={child.id}>
                    <button
                      type="button"
                      className="nt-section-item"
                      onClick={() => onOpenPage?.(child.id)}
                    >
                      <span className="nt-bullet" aria-hidden="true">
                        •
                      </span>
                      <span>{deriveDisplayName(child) || child.id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          />
        </div>
      </div>
    </OutlinerContext.Provider>
  );
}
