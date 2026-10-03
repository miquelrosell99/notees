/**
 * ExtendedBySection — the classes extending this one (transitive), as a
 * bottom system section (a backlink-class read, like Linked references):
 * read-only outline rows that open the subclass. Hidden when empty (owner
 * rule); expanded by default — the list is identity info, usually short.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../../Icon.js";
import { Section } from "../../Section.js";
import { NodeCollection } from "../../views/index.js";

type AnyClient = WorkspaceClient | WorkerClient;

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
  if (children.length === 0) return null;

  return (
    <Section
      client={client}
      title="Extended by"
      icon={<Icon path="mdi-file-tree" size={0.9} />}
      badge={children.length}
      defaultCollapsed={false}
      load={() => client.getClassChildren(classId)}
      emptyText="No subclasses."
      renderResults={(subclasses) => (
        <NodeCollection
          viewMode="outline"
          client={client}
          items={subclasses.map((node) => ({ node }))}
          readOnly
          onNodeClick={(id) => onOpenClass?.(id)}
        />
      )}
    />
  );
}
