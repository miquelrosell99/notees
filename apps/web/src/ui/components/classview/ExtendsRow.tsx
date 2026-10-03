/**
 * ExtendsRow — the class page's corner cluster: the class's PARENT classes
 * as colored pills (the page-view Classes row's class-page analogue). ×
 * removes a parent, "+" opens the class-only picker; both write through
 * `class.setExtends` (replace semantics), so the store's loud cycle failure
 * surfaces via `onError` (the transient banner ClassView renders). Extends
 * order is deterministic — no drag-sort.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { NodePills } from "../NodePills.js";

type AnyClient = WorkspaceClient | WorkerClient;

export function ExtendsRow({
  client,
  classId,
  onOpenClass,
  onError,
}: {
  client: AnyClient;
  classId: string;
  /** Parent-pill navigation (a parent class opens its own Class View). */
  onOpenClass?: ((classId: string) => void) | undefined;
  /** The setClassExtends failure (extends cycles fail loud in the store). */
  onError: (message: string) => void;
}) {
  const parents = client.getClassParents(classId);

  /** Replace the extends set; the store fails loud on cycles. */
  const replace = (nextParentIds: string[]) => {
    client.setClassExtends(classId, nextParentIds).catch((err: unknown) => {
      onError(err instanceof Error ? err.message : "Failed to update extends");
    });
  };

  return (
    <div className="nt-page-classes-corner">
      <div className="nt-extends-row">
        <NodePills
          client={client}
          nodeId={classId}
          classIds={parents}
          onOpenPage={onOpenClass}
          sortable={false}
          addLabel="Add parent class"
          excludePickerNodeId={classId}
          removeLabel={(label) => `Remove parent ${label}`}
          actions={{
            add: (parentId) => replace([...parents, parentId]),
            remove: (parentId) => replace(parents.filter((id) => id !== parentId)),
          }}
        />
      </div>
    </div>
  );
}
