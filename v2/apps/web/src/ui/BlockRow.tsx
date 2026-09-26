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
 * Edit mode is also entered in response to a focus request from the
 * outliner gestures (Enter creates a sibling, Backspace-delete hands the
 * caret to the previous block). Data comes from the WorkspaceClient read
 * API; the client itself arrives through OutlinerContext.
 */

import { useEffect, useState, type MouseEvent } from "react";

import type { BlockTreeNode } from "@/core/workspace-client.js";

import { InlineTokens } from "./InlineTokens.js";
import { BlockTextEditor, type EditorCaret } from "./BlockTextEditor.js";
import { EmbedView } from "./EmbedView.js";
import { useOutliner } from "./outliner-context.js";

interface BlockRowProps {
  tree: BlockTreeNode;
  resolveName?: ((nodeId: string) => string | null) | undefined;
}

export function BlockRow({ tree, resolveName }: BlockRowProps) {
  const { node, children } = tree;
  const { focusRequest, acknowledgeFocus, collapsed, toggleCollapse } = useOutliner();
  const [editing, setEditing] = useState(false);
  const [caret, setCaret] = useState<EditorCaret>("end");
  const isCollapsed = collapsed.has(node.id);

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

  return (
    <div className="nt-block">
      <div className="nt-block-row">
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
        <div className="nt-block-content" onClick={enterEdit}>
          {editing ? (
            <BlockTextEditor node={node} caret={caret} onExitEdit={() => setEditing(false)} />
          ) : (
            <InlineTokens
              tokens={node.contentAst}
              resolveName={resolveName}
              renderEmbed={(id) => <EmbedView nodeId={id} />}
            />
          )}
        </div>
      </div>
      {children.length > 0 && !isCollapsed && (
        <div className="nt-block-children">
          {children.map((child) => (
            <BlockRow key={child.node.id} tree={child} resolveName={resolveName} />
          ))}
        </div>
      )}
    </div>
  );
}
