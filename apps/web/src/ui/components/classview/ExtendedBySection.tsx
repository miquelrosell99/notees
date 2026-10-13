/**
 * ExtendedBySection — the classes DIRECTLY extending this one, as a
 * bottom system section (a backlink-class read): a flat list — a subclass
 * appears only under its direct parent (if book extends source and x extends
 * book, x shows under book's section, not under source) — read-only rows
 * that open the subclass. Hidden when empty; expanded by default (identity
 * info, usually short).
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../../Icon.js";
import { Section } from "../../Section.js";
import { NodeCollection } from "../../views/index.js";
import type { NodeCollectionItem } from "../../views/index.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** Direct extends-children only — no transitive nesting. */
function buildItems(client: AnyClient, parentId: string): NodeCollectionItem[] {
  return client.getDirectClassChildren(parentId).map((child) => ({
    node: child as ClientNode,
  }));
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
  const items = buildItems(client, classId);

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
          onNodeClick={(id) => onOpenClass?.(id)}
        />
      )}
    />
  );
}
