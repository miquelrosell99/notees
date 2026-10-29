/**
 * ExtendedBySection — the classes extending this one, as a bottom system
 * section (a backlink-class read): a multi-level tree of DIRECT extends
 * edges — the top level is the direct extenders only, each nested under its
 * own direct parent (if book extends source and x extends book, source's
 * section shows book with x nested as book's child — x is never a top-level
 * row under source) — read-only rows that open the subclass. Hidden when
 * empty; expanded by default (identity info, usually short). The tree
 * opens on the Name A–Z sort, every sibling level; the
 * sort button in the section switches it back to the Default order.
 * Composes through the CollectionSection skin (the conversion slice): the
 * eager count gates AND names the header badge, the tree rides the skin's
 * lazy read.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client/index.js";

import { Icon } from "../../ui/Icon.js";
import { CollectionSection } from "../collection/CollectionSection.js";
import type { NodeCollectionItem } from "../collection/index.js";

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
  /** The peek-card surface: start collapsed. */
  sectionsStartCollapsed = false,
}: {
  client: AnyClient;
  classId: string;
  onOpenClass?: ((classId: string) => void) | undefined;
  sectionsStartCollapsed?: boolean | undefined;
}) {
  // Eager read: the hide-when-empty rule needs the count before the section's
  // lazy contract starts (same pattern as SystemSections' gates).
  const children = client.getDirectClassChildren(classId);
  // No memo: the tree is rebuilt per render from the eager read. The old
  // [client, classId] memo cached the FIRST sync-window read forever — the
  // gate re-read 34 on the parent's notification while the rows stayed the
  // mount-time [] ("No subclasses" under a gate of 34, owner-caught 2026-10-12).
  // The skin re-renders per client notification (the hook's version) and
  // re-runs the read while expanded, so both halves keep the contract.
  const items = buildTree(client, classId);

  return (
    <CollectionSection
      client={client}
      title="Extended by"
      icon={<Icon path="mdi-file-tree" size={0.9} />}
      count={children.length}
      hideWhenEmpty
      defaultCollapsed={sectionsStartCollapsed}
      className="nt-section"
      emptyText="No subclasses."
      viewMode="outline"
      read={() => items}
      collection={{
        tree: true,
        readOnly: true,
        hideBacklinkCount: true,
        showBreadcrumbs: false,
        defaultSortMode: "alphabetical",
        onNodeClick: (id) => onOpenClass?.(id),
      }}
    />
  );
}
