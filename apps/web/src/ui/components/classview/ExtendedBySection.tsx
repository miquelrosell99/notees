/**
 * ExtendedBySection — the classes extending this one (transitive), as a
 * bottom system section (a backlink-class read): a multi-level TREE per the
 * owner refinement — episode nests under TV series under its parent class —
 * read-only rows that open the subclass. Hidden when empty; expanded by
 * default (identity info, usually short).
 */

import { useMemo } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../../Icon.js";
import { Section } from "../../Section.js";
import { NodeCollection } from "../../views/index.js";
import type { NodeCollectionItem } from "../../views/index.js";

type AnyClient = WorkspaceClient | WorkerClient;

/** Build the nested items: direct extends-children, each with its subtree. */
function buildTree(
  client: AnyClient,
  parentId: string,
  seen: ReadonlySet<string>,
): NodeCollectionItem[] {
  return client
    .getClassChildren(parentId)
    .filter((child) => !seen.has(child.id))
    .map((child) => {
      const nextSeen = new Set(seen).add(child.id);
      const grandchildren = buildTree(client, child.id, nextSeen);
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
  const children = client.getClassChildren(classId);
  // Must run BEFORE the empty early return (rules of hooks): the extends set
  // can flip 0↔N on this same instance when an edge arrives via sync.
  // React 19 happens to tolerate this instance's 0↔1-hook flip (a zero-hook
  // fiber re-mounts), but the shape is the known crash class — the day a
  // hook lands above the return it throws #310, as TitleEditor did.
  const items = useMemo(() => buildTree(client, classId, new Set([classId])), [client, classId]);

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
