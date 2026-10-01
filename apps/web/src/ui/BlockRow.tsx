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
import { MetadataSection } from "./components/MetadataSection.js";
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
}

export function BlockRow({ tree, client, resolveName }: BlockRowProps) {
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
  });

  useEffect(() => {
    if (focusRequest === null || focusRequest.id !== node.id) return;
    acknowledgeFocus();
    setCaret(focusRequest.caret);
    setEditing(true);
  }, [focusRequest, node.id, acknowledgeFocus]);

  const enterEdit = (event: MouseEvent<HTMLDivElement>) => {
    if (editing) return;
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
      className={`nt-block${dropClass}`}
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
            className={
              isCollapsed
                ? "nt-bullet nt-bullet-collapsed"
                : gripIcon !== null
                  ? "nt-bullet nt-bullet-icon"
                  : "nt-bullet"
            }
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
            {gripIcon !== null ? <Icon path={gripIcon} size={0.8} /> : "\u2022"}
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
      </div>
      {/* Block-level metadata: classes / tags / properties, and only when
          the block actually carries some (hideWhenEmpty). */}
      <MetadataSection client={client} nodeId={node.id} onOpenPage={openNode} hideWhenEmpty />
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
              <BlockRow key={child.node.id} tree={child} client={client} resolveName={resolveName} />
            ))}
          </div>
        </SortableContext>
      )}
    </div>
  );
}
