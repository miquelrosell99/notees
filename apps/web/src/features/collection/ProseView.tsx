/**
 * ProseView — the prose/flat mode for tree contexts: the SAME editable
 * BlockRow tree with the `nt-prose` display transform (app.css): bullets
 * hidden, nesting indents flattened to full-width rows, paragraph spacing.
 * Structure and editing are untouched — a view transform only (SCHEMA.md:
 * display state, never content). Collapse is HONORED, not ignored (owner
 * ruling 2026-10-15): the fold set is read exactly as in outline — collapsed
 * subtrees hide, the chevron start-anchors the row (hover-revealed; PERSISTENT
 * at rest while collapsed — the persistent chevron IS the collapsed
 * indicator), and the fold chords act on the same state. Only the v1
 * indent-line rail stays outline-only (prose has no indent line — the
 * `proseMode` flag hides it). The condensed layer composes over prose — the
 * most Nelson-like surface: a flat page of excerpts (the page body passes
 * `condensed` through).
 * Like the editable outline tree, the prose surface is the live
 * editing tree — deliberately NOT windowed (a window could hide a
 * just-created block).
 */

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { displayNameFromClient } from "../../ui/dateDisplay.js";
import { BlockRow } from "../../ui/BlockRow.js";
import { registerView } from "./registry.js";
import type { NodeCollectionItem, NodeCollectionProps } from "./types.js";

function toBlockTree(item: NodeCollectionItem): import("@/core/workspace-client/index.js").BlockTreeNode {
  return { node: item.node, children: (item.children ?? []).map(toBlockTree) };
}

export function ProseView(props: NodeCollectionProps) {
  // The readOnly escape hatch mirrors OutlineView: containers that are not
  // drag-ordered editing surfaces (the reference sections) pass
  // `readOnly={false}` to make rows editable while `editable` stays false.
  const { client, items = [], editable = false, readOnly = !editable, condensed = false } = props;
  const resolveName = (id: string) => displayNameFromClient(client, id);
  if (items.length === 0 && props.parent === undefined) return null;
  return (
    <SortableContext items={items.map((t) => t.node.id)} strategy={verticalListSortingStrategy}>
      <div className="nt-block-tree nt-prose">
        {/* The focused-block view (owner 2026-10-20): the parent renders as
            an editable TOP-LEVEL HEADER — the title-variant row (bullet-less,
            chrome-less, Newsreader display type). Title-is-content: the
            block's own text IS the header; the children render below,
            flattened by the prose transform like the page body. */}
        {props.parent !== undefined && (
          <div className="nt-prose-parent">
            <BlockRow
              tree={{ node: props.parent, children: [] }}
              client={client}
              resolveName={resolveName}
              readOnly={readOnly}
              variant="title"
            />
          </div>
        )}
        {items.map((item) => (
          <BlockRow
            key={item.node.id}
            tree={toBlockTree(item)}
            client={client}
            resolveName={resolveName}
            readOnly={readOnly}
            proseMode
            condensed={condensed}
          />
        ))}
        {/* The focused view's "+ Add block" ghost trails the flattened
            list (prose has no children container to ride inside — the end
            of the list IS the child indent level here). */}
        {props.parent !== undefined && props.parentTrailing}
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
