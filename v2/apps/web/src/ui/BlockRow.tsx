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

import { useContext, useEffect, useState, type MouseEvent } from "react";

import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { BlockTreeNode } from "@/core/workspace-client.js";

import { InlineTokens } from "./InlineTokens.js";
import { BlockTextEditor, type EditorCaret } from "./BlockTextEditor.js";
import { EmbedView } from "./EmbedView.js";
import { QueryBlockView } from "./QueryBlockView.js";
import { WhiteboardCanvas } from "./WhiteboardCanvas.js";
import { DropLineContext } from "./block-dnd.js";
import { useOutliner } from "./outliner-context.js";

interface BlockRowProps {
  tree: BlockTreeNode;
  resolveName?: ((nodeId: string) => string | null) | undefined;
}

export function BlockRow({ tree, resolveName }: BlockRowProps) {
  const { node, children } = tree;
  const {
    client: outlinerClient,
    rootId,
    openNode,
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
        <span className="nt-block-grip" title="Drag to move" {...attributes} {...listeners}>
          {children.length > 0 ? (
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
          ) : (
            <span className="nt-bullet" aria-hidden="true">
              •
            </span>
          )}
        </span>
        <div className="nt-block-content" onClick={enterEdit}>
          {editing ? (
            <BlockTextEditor node={node} caret={caret} onExitEdit={() => setEditing(false)} />
          ) : (
            <InlineTokens
              tokens={node.contentAst}
              resolveName={resolveName}
              renderEmbed={(id) => <EmbedView nodeId={id} />}
              renderQuery={(token, index) => (
                <QueryBlockView
                  client={outlinerClient}
                  ownerId={node.id}
                  tokenIndex={index}
                  queryAst={(token as { queryAst?: unknown }).queryAst}
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
      {children.length > 0 && !isCollapsed && (
        <SortableContext items={children.map((child) => child.node.id)} strategy={verticalListSortingStrategy}>
          <div className="nt-block-children">
            {children.map((child) => (
              <BlockRow key={child.node.id} tree={child} resolveName={resolveName} />
            ))}
          </div>
        </SortableContext>
      )}
    </div>
  );
}
