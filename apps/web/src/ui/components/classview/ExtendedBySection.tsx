/**
 * ExtendedBySection — the classes extending this one, as a bottom system
 * section (a backlink-class read): a multi-level tree of DIRECT extends
 * edges — the top level is the direct extenders only, each nested under its
 * own direct parent (if book extends source and x extends book, source's
 * section shows book with x nested as book's child — x is never a top-level
 * row under source) — read-only rows that open the subclass. Hidden when
 * empty; expanded by default (identity info, usually short).
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../../Icon.js";
import { Section } from "../../Section.js";
import { NodeCollection } from "../../views/index.js";
import type { NodeCollectionItem } from "../../views/index.js";

type AnyClient = WorkspaceClient | WorkerClient;

/**
 * Build the nested items from DIRECT extends edges only: each level lists
 * the parent's direct extenders (never the transitive closure — a
 * grandchild must not also appear as a top-level row under the ancestor).
 */
function buildTree(client: AnyClient, parentId: string): NodeCollectionItem[] {
  return client.getDirectClassChildren(parentId).map((child) => {
    const grandchildren = buildTree(client, child.id);
    const item: NodeCollectionItem = { node: child as ClientNode };
    if (grandchildren.length > 0) item.children = grandchildren;
    return item;
  });
}

export function ExtendedBySection({
  client,
  classId,
  onOpenClass,
}: {
  client: AnyClient;
  classId: string;
  onOpenClass?: ((classId: string) => void) | undefined;
}) {
  // Eager read: the hide-when-empty rule needs the count before the section's
  // lazy contract starts (same pattern as SystemSections' count badges).
  const children = client.getDirectClassChildren(classId);
  // No memo: the tree is rebuilt per render from the eager read. The old
  // [client, classId] memo cached the FIRST sync-window read forever — the
  // badge re-read 34 on the parent's notification while the rows stayed the
  // mount-time [] ("No subclasses" under a 34 badge, owner-caught 2026-10-12).
  const items = buildTree(client, classId);

  if (children.length === 0) return null;

  return (
    <Section
      client={client}
      title="Extended by"
      icon={<Icon path="mdi-file-tree" size={0.9} />}
      badge={children.length}
      defaultCollapsed={false}
      load={() => items}
      emptyText="No subclasses."
      renderResults={() => (
        <NodeCollection
          viewMode="outline"
          client={client}
          items={items}
          tree
          readOnly
          hideBacklinkCount
          onNodeClick={(id) => onOpenClass?.(id)}
        />
      )}
    />
  );
}
