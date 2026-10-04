/**
 * BlockRow — one block: bullet dot (a chevron toggle when the block has
 * children) + inline token content + nested children (recursive, indented).
 * Two display modes on the content div:
 *
 * - read mode: InlineTokens (marks/chips render read-only per SCHEMA.md).
 * - edit mode: a click swaps in BlockTextEditor (contentEditable prose
 *   editing, the outliner keyboard contract).
 *
 * A collapsed block (session-local display state from OutlinerContext) hides
 * its entire subtree — the children container is not rendered. The chevron
 * toggles collapse without entering edit mode (stopPropagation). In prose
 * view (`ignoreCollapse`) collapse state is ignored instead: every subtree
 * renders and no chevron mounts — the session set is left untouched, so
 * switching back to outline restores the hidden subtrees.
 *
 * Drag-and-drop: each row is sortable within its sibling group (dnd-kit,
 * vertical strategy) via the bullet/chevron grip handle. Drops resolve to
 * `object.move` through the intent model in block-dnd.ts; the live drop
 * indicator arrives through DropLineContext.
 *
 * Edit mode is also entered in response to a focus request from the
 * outliner gestures (Enter creates a sibling, Backspace-delete hands the
 * caret to the previous block). Data comes from the WorkspaceClient read
 * API; the client itself arrives through OutlinerContext.
 */

import { useContext, useEffect, useMemo, useState, type MouseEvent } from "react";

import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { BlockTreeNode, WorkspaceClient } from "@/core/workspace-client.js";
import type { WorkerClient } from "@/core/worker-client.js";

import { Icon } from "./Icon.js";
import { InlineTokens } from "./InlineTokens.js";
import { AssetView } from "./AssetView.js";
import { BlockBacklinkPanel, BlockBacklinkToggle } from "./BlockBacklinks.js";
import { BlockTextEditor, type EditorCaret } from "./BlockTextEditor.js";
import { PropertiesSection, TagsRow } from "./components/MetadataSection.js";
import { NodePills } from "./components/NodePills.js";
import { NodeContextMenu } from "./components/NodeContextMenu.js";
import { openNodeLinkMenu } from "./components/NodeLinkContextMenu.js";
import { classIconMap, nodeIcon } from "./iconFor.js";
import { EmbedView } from "./EmbedView.js";
import { EmbedCardView } from "./EmbedCardView.js";
import { QueryBlockView } from "./QueryBlockView.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { DropLineContext } from "./block-dnd.js";
import { useOutliner } from "./outliner-context.js";
import { Button } from "./components/ui/index.js";
import { InlineConfirmButton } from "./components/ui/InlineConfirmButton.js";
import { tableClassIdOf } from "./components/tableFamily.js";
import { addTableColumn, addTableRow, deleteTableColumn, deleteTableRow, tableColumnCount } from "./components/tableGrid.js";

interface BlockRowProps {
  tree: BlockTreeNode;
  client: WorkspaceClient | WorkerClient;
  resolveName?: ((nodeId: string) => string | null) | undefined;
  /**
   * Read-only projection (the v1 blocks-list readonly mode): renders the same
   * row chrome but disables every mutation gesture — no drag, no edit on
   * click, no context menu; clicking the content opens the node instead.
   * Used by the Child pages tree and the Class View's "Extended by" list.
   */
  readOnly?: boolean | undefined;
  /**
   * Prose-view transform: collapse state is ignored — collapsed ids still
   * render their full subtree and no chevron mounts (nothing left to expand
   * or collapse). Threaded down the recursion by the view that sets it.
   */
  ignoreCollapse?: boolean | undefined;
  /**
   * §34.34 B4 table-row projection: set by the table container's grid branch
   * on each of its row children. The row root becomes a CSS-subgrid row and
   * renders ONLY its cell children (each an ordinary editable block) — no
   * row chrome of its own.
   */
  tableRow?: boolean | undefined;
}

export function BlockRow({ tree, client, resolveName, readOnly = false, ignoreCollapse = false, tableRow = false }: BlockRowProps) {
  const [gripMenu, setGripMenu] = useState<{ x: number; y: number } | null>(null);
  const { node, children } = tree;
  const {
    client: outlinerClient,
    rootId,
    openNode,
    openInSidebar,
    focusRequest,
    acknowledgeFocus,
    collapsed,
    toggleCollapse,
    selectionEnabled,
    selection,
    selectionAnchor,
    setSelectionAnchor,
    replaceSelection,
    rangeBetween,
    toggleSelected,
    clearSelection,
    consumeDragClick,
  } = useOutliner();
  const dropLine = useContext(DropLineContext);
  const [editing, setEditing] = useState(false);
  const [caret, setCaret] = useState<EditorCaret>("end");
  // Right-gutter backlink toggle (SCHEMA.md:117): the badge reads the
  // materialized count (cheap stored number, renders unconditionally at 0
  // hides the toggle); the linked-references query stays lazy until the
  // first expand.
  const backlinkCount = client.getBacklinkCount(node.id);
  const [backlinksExpanded, setBacklinksExpanded] = useState(false);
  const isCollapsed = !ignoreCollapse && collapsed.has(node.id);
  // Sortable within this row's sibling group; the bullet/chevron area is the
  // drag handle (whole-row drag would fight text editing). A small activation
  // distance keeps plain clicks untouched.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: node.id,
    disabled: readOnly,
  });

  useEffect(() => {
    if (focusRequest === null || focusRequest.id !== node.id) return;
    acknowledgeFocus();
    if (readOnly) return;
    setCaret(focusRequest.caret);
    setEditing(true);
  }, [focusRequest, node.id, acknowledgeFocus, readOnly]);

  const enterEdit = (event: MouseEvent<HTMLDivElement>) => {
    if (editing) return;
    // A trailing click right after a selection drag must not enter edit mode.
    if (consumeDragClick()) return;
    if (readOnly) {
      // Read-only projection: clicking the row opens the node.
      openNode(node.id);
      return;
    }
    // §34.19 block multi-selection: shift+click extends the range from the
    // anchor, Ctrl/Cmd+click toggles one row — neither enters edit mode.
    if (selectionEnabled && event.shiftKey) {
      const anchor = selectionAnchor ?? node.id;
      setSelectionAnchor(anchor);
      replaceSelection(new Set(rangeBetween(anchor, node.id)), anchor);
      return;
    }
    if (selectionEnabled && (event.ctrlKey || event.metaKey)) {
      if (selectionAnchor === null) setSelectionAnchor(node.id);
      toggleSelected(node.id);
      return;
    }
    // A plain click with a live selection resets it, then edits as usual.
    if (selection.size > 0) clearSelection();
    setCaret({ x: event.clientX, y: event.clientY });
    setEditing(true);
  };

  const gripIcon = useMemo(
    () => nodeIcon(node, classIconMap(outlinerClient.listClasses())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node, node.classIds],
  );

  const dropClass =
    dropLine !== null && dropLine.targetId === node.id ? ` nt-drop-${dropLine.intent}` : "";
  const selectedClass = selection.has(node.id) ? " nt-block--selected" : "";

  // §34.34 B4: a block carrying the table class renders its children (rows)
  // as a CSS grid instead of the outline list. The class says what-it-is
  // (the whiteboard pattern) — the same branch covers read-only projections.
  const isTableContainer = !tableRow && node.classIds.includes(tableClassIdOf(outlinerClient));

  // Table-row projection: the root is the subgrid row; only the cell blocks
  // render, each through the ordinary BlockRow path (a cell IS a block — the
  // existing editor machinery applies). All hooks ran above, so the early
  // return is safe.
  if (tableRow) {
    return (
      <div
        className="nt-table-row"
        ref={setNodeRef}
        data-block-id={node.id}
        style={{
          transform: CSS.Transform.toString(transform),
          transition,
          opacity: isDragging ? 0.4 : undefined,
        }}
      >
        <SortableContext items={children.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
          {children.map((child) => (
            <BlockRow
              key={child.node.id}
              tree={child}
              client={client}
              resolveName={resolveName}
              readOnly={readOnly}
              ignoreCollapse={ignoreCollapse}
            />
          ))}
        </SortableContext>
      </div>
    );
  }

  return (
    <div
      className={`nt-block${readOnly ? " nt-block--readonly" : ""}${dropClass}${selectedClass}`}
      ref={setNodeRef}
      data-block-id={node.id}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : undefined,
      }}
    >
      <div className="nt-block-row">
        <span
          className="nt-block-grip"
          title="Drag to move"
          {...attributes}
          {...listeners}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (readOnly) return;
            setGripMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          {children.length > 0 && !ignoreCollapse && (
            <button
              type="button"
              className="nt-block-chevron"
              aria-label={isCollapsed ? "Expand block" : "Collapse block"}
              aria-expanded={!isCollapsed}
              onClick={(event) => {
                // The chevron is a display toggle, not content editing.
                event.stopPropagation();
                toggleCollapse(node.id);
              }}
            >
              {isCollapsed ? "\u25B8" : "\u25BE"}
            </button>
          )}
          <span
            className={`nt-bullet${isCollapsed && children.length > 0 ? " nt-bullet--collapsed" : ""}`}
            title="Zoom in (Shift+click: open in sidebar)"
            onClick={(event) => {
              event.stopPropagation();
              // Shift+click peeks the block in the right sidebar; a plain
              // click zooms to the focused block view.
              if (event.shiftKey) {
                openInSidebar(node.id);
              } else {
                openNode(node.id);
              }
            }}
          >
            {children.length > 0 && <span className="nt-bullet-ring" aria-hidden="true" />}
            {gripIcon !== null ? (
              <span className="nt-bullet-icon">
                <Icon path={gripIcon} size={0.8} />
              </span>
            ) : (
              <span className="nt-bullet-dot" aria-hidden="true" />
            )}
          </span>
        </span>
        <div className="nt-block-content" onClick={enterEdit}>
          {editing ? (
            <BlockTextEditor node={node} caret={caret} onExitEdit={() => setEditing(false)} />
          ) : (
            <InlineTokens
              tokens={node.contentAst}
              resolveName={resolveName}
              resolveVerb={(schemaId) =>
                outlinerClient.listPropertySchemas().find((schema) => schema.id === schemaId)?.name ?? null
              }
              onOpenNode={openNode}
              onMentionMenu={(info) => openNodeLinkMenu({ blockId: node.id, ...info })}
              resolveColor={(id) => {
                const target = outlinerClient.getNode(id);
                return target === undefined ? null : outlinerClient.effectiveNodeColor(target);
              }}
              renderEmbed={(id, _token, index) => (
                <EmbedView nodeId={id} hostId={node.id} tokenIndex={index} />
              )}
              renderEmbedCard={(id, view, _token, index) => (
                <EmbedCardView nodeId={id} view={view} hostId={node.id} tokenIndex={index} />
              )}
              renderQuery={(token, index) => (
                <QueryBlockView
                  client={outlinerClient}
                  ownerId={node.id}
                  tokenIndex={index}
                  queryAst={(token as { queryAst?: unknown }).queryAst}
                  view={(token as { view?: unknown }).view}
                  rootId={rootId}
                  onOpenNode={openNode}
                />
              )}
              renderWhiteboard={(_token, index) => (
                <WhiteboardCanvas
                  client={outlinerClient}
                  hostId={node.id}
                  tokenIndex={index}
                  embedded
                />
              )}
              renderAsset={(token, _index, fullBleed) => {
                const assetId = (token as { assetId?: unknown }).assetId;
                return typeof assetId === "string" ? (
                  <AssetView client={client} assetId={assetId} fullBleed={fullBleed} />
                ) : null;
              }}
            />
          )}
        </div>
        {/* Right end of the row: the classes column (first pill + "+N"
            overflow popup, drag to reorder) and the backlink gutter toggle
            (SCHEMA.md:117 — the count badge rides the materialized
            node_stats number). The gutter is reference material, so it shows
            in read-only projections too. */}
        {(backlinkCount > 0 || !readOnly) && (
          <div className="nt-block-row-end">
            {!readOnly && (
              <div className="nt-block-classes">
                <NodePills
                  client={client}
                  nodeId={node.id}
                  classIds={node.classIds}
                  onOpenPage={openNode}
                  overflow
                  iconOnlyAdd
                />
              </div>
            )}
            {backlinkCount > 0 && (
              <BlockBacklinkToggle
                count={backlinkCount}
                expanded={backlinksExpanded}
                onToggle={() => setBacklinksExpanded((v) => !v)}
              />
            )}
          </div>
        )}
      </div>
      {/* Expanded block backlinks: the linked-references system query scoped
          to this block, lazy per the section contract (query on first
          toggle, cached until an invalidating notification). */}
      {backlinkCount > 0 && (
        <BlockBacklinkPanel nodeId={node.id} expanded={backlinksExpanded} client={client} />
      )}
      {/* Tags: dedicated row below the block row, only when set (assignment
          rides the `#` trigger). */}
      {!readOnly && node.tagIds.length > 0 && (
        <div className="nt-block-tags">
          <TagsRow client={client} nodeId={node.id} tagIds={node.tagIds} onOpenPage={openNode} />
        </div>
      )}
      {/* Properties: the same collapsed "Properties N" section the page view
          uses; hidden entirely when the block carries no properties. */}
      {!readOnly && (
        <PropertiesSection
          client={client}
          nodeId={node.id}
          onOpenPage={openNode}
          hideWhenEmpty
        />
      )}
      {/* Block-level metadata now lives around the row: classes ride the
          right-hand column, tags the dedicated row below, properties the
          collapsed "Properties N" section (all above). */}
      <NodeContextMenu
        state={gripMenu === null ? null : { ...gripMenu, node, isPage: false }}
        client={outlinerClient}
        onClose={() => setGripMenu(null)}
        onOpenNode={openNode}
      />
      {/* §34.34 B4: a table container's children are the grid rows. The
          column template comes from the FIRST row's cell count; ragged rows
          show blanks (fewer cells) or spill into implicit tracks (more).
          The + Row / + Column hover affordance rides the container (hidden
          in read-only projections). */}
      {isTableContainer ? (
        <>
          {!readOnly && (
            <div className="nt-table-toolbar" role="toolbar" aria-label="Table">
              <Button
                size="xs"
                variant="ghost"
                icon="mdiTableRowPlusAfter"
                aria-label="Add row"
                onClick={() => {
                  void addTableRow(client, node.id, tableColumnCount(children));
                }}
              >
                Row
              </Button>
              <Button
                size="xs"
                variant="ghost"
                icon="mdiTableColumnPlusAfter"
                aria-label="Add column"
                onClick={() => {
                  void addTableColumn(client, children);
                }}
              >
                Column
              </Button>
              {/* − Row / − Column: the inline-confirm pattern (a delete is
                  destructive; the confirm/check row replaces the trigger).
                  The last row / right-most column are the targets — the
                  append gestures' mirror. */}
              <InlineConfirmButton
                size="sm"
                variant="ghost"
                title="Delete last row"
                confirmTitle="Confirm delete row"
                cancelTitle="Cancel"
                disabled={children.length === 0}
                onConfirm={() => {
                  const last = children[children.length - 1];
                  if (last !== undefined) void deleteTableRow(client, last);
                }}
              >
                − Row
              </InlineConfirmButton>
              <InlineConfirmButton
                size="sm"
                variant="ghost"
                title="Delete last column"
                confirmTitle="Confirm delete column"
                cancelTitle="Cancel"
                disabled={tableColumnCount(children) === 0}
                onConfirm={() => {
                  void deleteTableColumn(client, children, tableColumnCount(children) - 1);
                }}
              >
                − Column
              </InlineConfirmButton>
            </div>
          )}
          {children.length > 0 && !isCollapsed && (
            <div
              className="nt-table"
              style={{
                gridTemplateColumns: `repeat(${tableColumnCount(children)}, minmax(0, 1fr))`,
              }}
            >
              <SortableContext items={children.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
                {children.map((child) => (
                  <BlockRow
                    key={child.node.id}
                    tree={child}
                    client={client}
                    resolveName={resolveName}
                    readOnly={readOnly}
                    ignoreCollapse={ignoreCollapse}
                    tableRow
                  />
                ))}
              </SortableContext>
            </div>
          )}
        </>
      ) : (
      children.length > 0 && !isCollapsed && (
        <SortableContext items={children.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
          <div className="nt-block-children">
            {children.map((child) => (
              <BlockRow
                key={child.node.id}
                tree={child}
                client={client}
                resolveName={resolveName}
                readOnly={readOnly}
                ignoreCollapse={ignoreCollapse}
              />
            ))}
          </div>
        </SortableContext>
      )
      )}
    </div>
  );
}
