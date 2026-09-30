/**
 * ReferenceSubtree — renders a referencing node (and its children,
 * recursively) with the main editor's block look: bullets/chevrons,
 * indentation, click-to-edit in place. Writes go through the shared
 * outliner client, so edits inside a reference behave exactly like edits
 * in the page body (same ops, same sync).
 */

import { useEffect, useState, type MouseEvent } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { BlockTextEditor, type EditorCaret } from "../BlockTextEditor.js";
import { InlineTokens } from "../InlineTokens.js";

type AnyClient = WorkspaceClient | WorkerClient;

function ReferenceBlock({
  client,
  node,
  onOpenNode,
}: {
  client: AnyClient;
  node: ClientNode;
  onOpenNode?: ((nodeId: string) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [caret, setCaret] = useState<EditorCaret>("end");
  const [collapsed, setCollapsed] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);
  void version; // re-render trigger only

  const children = client.getChildren(node.id);
  const enterEdit = (event: MouseEvent<HTMLDivElement>) => {
    if (editing) return;
    setCaret({ x: event.clientX, y: event.clientY });
    setEditing(true);
  };

  return (
    <div className="nt-block nt-refblock-item" data-block-id={node.id}>
      <div className="nt-block-row">
        <span className="nt-block-grip">
          {children.length > 0 && (
            <button
              type="button"
              className="nt-block-chevron"
              aria-label={collapsed ? "Expand block" : "Collapse block"}
              aria-expanded={!collapsed}
              onClick={(event) => {
                event.stopPropagation();
                setCollapsed((value) => !value);
              }}
            >
              {collapsed ? "▸" : "▾"}
            </button>
          )}
          <span
            className={collapsed ? "nt-bullet nt-bullet-collapsed" : "nt-bullet"}
            title="Zoom in"
            onClick={(event) => {
              event.stopPropagation();
              onOpenNode?.(node.id);
            }}
          >
            •
          </span>
        </span>
        <div className="nt-block-content" onClick={enterEdit}>
          {editing ? (
            <BlockTextEditor node={node} caret={caret} onExitEdit={() => setEditing(false)} />
          ) : (
            <InlineTokens
              tokens={node.contentAst}
              resolveName={(id) => client.getDisplayName(id)}
              onOpenNode={onOpenNode}
            />
          )}
        </div>
      </div>
      {children.length > 0 && !collapsed && (
        <div className="nt-block-children">
          {children.map((child) => (
            <ReferenceBlock key={child.id} client={client} node={child} onOpenNode={onOpenNode} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The referencing node plus its whole subtree, editable. */
export function ReferenceSubtree({
  client,
  rootId,
  onOpenNode,
}: {
  client: AnyClient;
  rootId: string;
  onOpenNode?: ((nodeId: string) => void) | undefined;
}) {
  const node = client.getNode(rootId);
  if (node === undefined) return null;
  return (
    <div className="nt-refblock-tree">
      <ReferenceBlock client={client} node={node} onOpenNode={onOpenNode} />
    </div>
  );
}
