/**
 * ExtendsRow — the class page's corner cluster, now a thin adapter over
 * ClassPillsList (M11): the class's PARENT classes as colored pills (the
 * page-view Classes row's class-page analogue). × removes a parent, "+"
 * opens the class-only picker; both write through `class.setExtends`
 * (replace semantics) via the shared `extendsCornerPills` relation config
 * (pageVariant.ts). Extends order is deterministic — no drag-sort.
 *
 * M12: the transient cycle banner is gone (render assumes a DAG); the
 * store's loud cycle failure (the applier's CycleError) lands in `onError`
 * — the console by default.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { ClassPillsList } from "../ClassPillsList.js";
import { extendsCornerPills } from "../pageVariant.js";

type AnyClient = WorkspaceClient | WorkerClient;

export function ExtendsRow({
  client,
  classId,
  onOpenClass,
  onError = undefined,
}: {
  client: AnyClient;
  classId: string;
  /** Parent-pill navigation (a parent class opens its own Class View). */
  onOpenClass?: ((classId: string) => void) | undefined;
  /** The setClassExtends failure (extends cycles fail loud in the store). */
  onError?: ((message: string) => void) | undefined;
}) {
  const pills = extendsCornerPills(client, classId, onError);

  return (
    <div className="nt-page-classes-corner">
      <ClassPillsList
        client={client}
        nodeId={classId}
        onOpenPage={onOpenClass}
        {...pills}
      />
    </div>
  );
}
