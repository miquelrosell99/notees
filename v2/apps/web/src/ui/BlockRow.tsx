/**
 * BlockRow — one block: bullet dot + inline token content + nested children
 * (recursive, indented). Two display modes on the content div:
 *
 * - read mode: InlineTokens (marks/chips render read-only per SCHEMA.md).
 * - edit mode: a click swaps in BlockTextEditor (contentEditable prose
 *   editing, the outliner keyboard contract).
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
import { useOutliner } from "./outliner-context.js";

interface BlockRowProps {
  tree: BlockTreeNode;
  resolveName?: ((nodeId: string) => string | null) | undefined;
}

export function BlockRow({ tree, resolveName }: BlockRowProps) {
  const { node, children } = tree;
  const { focusRequest, acknowledgeFocus } = useOutliner();
  const [editing, setEditing] = useState(false);
  const [caret, setCaret] = useState<EditorCaret>("end");

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
        <span className="nt-bullet" aria-hidden="true">
          •
        </span>
        <div className="nt-block-content" onClick={enterEdit}>
          {editing ? (
            <BlockTextEditor node={node} caret={caret} onExitEdit={() => setEditing(false)} />
          ) : (
            <InlineTokens tokens={node.contentAst} resolveName={resolveName} />
          )}
        </div>
      </div>
      {children.length > 0 && (
        <div className="nt-block-children">
          {children.map((child) => (
            <BlockRow key={child.node.id} tree={child} resolveName={resolveName} />
          ))}
        </div>
      )}
    </div>
  );
}
