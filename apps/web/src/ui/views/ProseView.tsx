/**
 * ProseView — the prose/flat mode for tree contexts: the SAME editable
 * BlockRow tree with the `nt-prose` display transform (app.css): bullets
 * hidden, nesting indents flattened to full-width rows, paragraph spacing.
 * Structure and editing are untouched — a view transform only (SCHEMA.md:
 * display state, never content). Collapse state is ignored here, not
 * cleared: `ignoreCollapse` renders every subtree and mounts no chevron,
 * leaving the session collapse set untouched for the outline view.
 * §34.70: like the editable outline tree, the prose surface is the live
 * editing tree — deliberately NOT windowed (a window could hide a
 * just-created block).
 */

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { displayNameFromClient } from "../dateDisplay.js";
import { BlockRow } from "../BlockRow.js";
import { registerView } from "./registry.js";
import type { NodeCollectionItem, NodeCollectionProps } from "./types.js";

function toBlockTree(item: NodeCollectionItem): import("@/core/workspace-client.js").BlockTreeNode {
  return { node: item.node, children: (item.children ?? []).map(toBlockTree) };
}

export function ProseView(props: NodeCollectionProps) {
  const { client, items, editable = false } = props;
  const readOnly = !editable;
  const resolveName = (id: string) => displayNameFromClient(client, id);
  if (items.length === 0) return null;
  return (
    <SortableContext items={items.map((t) => t.node.id)} strategy={verticalListSortingStrategy}>
      <div className="nt-block-tree nt-prose">
        {items.map((item) => (
          <BlockRow
            key={item.node.id}
            tree={toBlockTree(item)}
            client={client}
            resolveName={resolveName}
            readOnly={readOnly}
            ignoreCollapse
          />
        ))}
      </div>
    </SortableContext>
  );
}

registerView({
  id: "prose",
  label: "Prose",
  icon: "mdi-file-document-outline",
  component: ProseView,
  capabilities: { sorting: true },
});
