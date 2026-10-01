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
 * toggles collapse without entering edit mode (stopPropagation).
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
import { BlockTextEditor, type EditorCaret } from "./BlockTextEditor.js";
import { PropertiesSection, TagsRow } from "./components/MetadataSection.js";
import { ClassPills } from "./components/ClassPills.js";
import { NodeContextMenu } from "./components/NodeContextMenu.js";
import { classIconMap, nodeIcon } from "./iconFor.js";
import { EmbedView } from "./EmbedView.js";
import { QueryBlockView } from "./QueryBlockView.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { DropLineContext } from "./block-dnd.js";
import { useOutliner } from "./outliner-context.js";

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
}

export function BlockRow({ tree, client, resolveName, readOnly = false }: BlockRowProps) {
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
  } = useOutliner();
  const dropLine = useContext(DropLineContext);
  const [editing, setEditing] = useState(false);
  const [caret, setCaret] = useState<EditorCaret>("end");
  const isCollapsed = collapsed.has(node.id);
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
    if (readOnly) {
      // Read-only projection: clicking the row opens the node.
      openNode(node.id);
      return;
    }
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

  return (
    <div
      className={`nt-block${readOnly ? " nt-block--readonly" : ""}${dropClass}`}
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
          {children.length > 0 && (
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
              onOpenNode={openNode}
              resolveColor={(id) => {
                const target = outlinerClient.getNode(id);
                return target === undefined ? null : outlinerClient.effectiveNodeColor(target);
              }}
              renderEmbed={(id) => <EmbedView nodeId={id} />}
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
            />
          )}
        </div>
        {/* Classes: dedicated column at the right end of the row (first pill
            + "+N" overflow popup, drag to reorder). */}
        {!readOnly && (
          <div className="nt-block-classes">
            <ClassPills
              client={client}
              nodeId={node.id}
              classIds={node.classIds}
              onOpenPage={openNode}
              overflow
              iconOnlyAdd
            />
          </div>
        )}
      </div>
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
      {children.length > 0 && !isCollapsed && (
        <SortableContext items={children.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
          <div className="nt-block-children">
            {children.map((child) => (
              <BlockRow
                key={child.node.id}
                tree={child}
                client={client}
                resolveName={resolveName}
                readOnly={readOnly}
              />
            ))}
          </div>
        </SortableContext>
      )}
    </div>
  );
}
