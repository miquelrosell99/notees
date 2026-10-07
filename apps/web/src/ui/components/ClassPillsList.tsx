/**
 * ClassPillsList — ONE relation-parameterized pills row (the
 * main-content restructure): `query` carries the relation's current node
 * ids and `add` / `remove` (optionally `reorder`) carry the relation's
 * mutations — the component owns NO relation semantics of its own. The
 * page corner's instance-of relation (ClassesRow) and the class corner's
 * extends relation (the class variant's cornerPills config, see
 * pageVariant.ts) both render through it; the relation-specific chrome
 * (the ClassesRow label, the extends row wrapper) stays in the adapters.
 *
 * The rendering rides the existing NodePills machinery unchanged — colored
 * pills (effective color/icon), click to open, × to remove, right-click for
 * the node menu, drag-sort when `sortable`, the "+" class picker with the
 * ClassCreateModal create row — with the relation's mutations arriving as
 * the `actions` overrides that machinery already accepts.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { NodePills } from "./NodePills.js";

type AnyClient = WorkspaceClient | WorkerClient;

export function ClassPillsList({
  client,
  nodeId,
  /** The relation's current node ids (extends: the class's parent classes). */
  query,
  /** Add a node to the relation (the picker's pick / create result). */
  add,
  /** Remove a node from the relation (the pill's ×). */
  remove,
  /** Drag-sort commit — pass with `sortable` for user-defined orders. */
  reorder = undefined,
  onOpenPage = undefined,
  /** False for deterministic relations (extends order). */
  sortable = true,
  /** The "+" picker pill's visible label. */
  addLabel = "Add class",
  /** × aria-label factory (default "Remove class <label>"). */
  removeLabel = undefined,
  /** Excluded from the "+" picker (the extends picker excludes the class itself). */
  excludePickerNodeId = undefined,
  /** Wrapper class around the pills (the extends row's chrome hook). */
  listClassName = undefined,
}: {
  client: AnyClient;
  nodeId: string;
  query: string[];
  add: (classId: string) => void;
  remove: (classId: string) => void;
  reorder?: ((orderedIds: string[]) => void) | undefined;
  onOpenPage?: ((pageId: string) => void) | undefined;
  sortable?: boolean | undefined;
  addLabel?: string | undefined;
  removeLabel?: ((label: string) => string) | undefined;
  excludePickerNodeId?: string | undefined;
  listClassName?: string | undefined;
}) {
  const pills = (
    <NodePills
      client={client}
      nodeId={nodeId}
      classIds={query}
      onOpenPage={onOpenPage}
      sortable={sortable}
      addLabel={addLabel}
      removeLabel={removeLabel}
      excludePickerNodeId={excludePickerNodeId}
      actions={{ add, remove, reorder }}
    />
  );
  return listClassName !== undefined ? (
    <div className={listClassName}>{pills}</div>
  ) : (
    pills
  );
}
