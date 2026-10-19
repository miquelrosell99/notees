import { parseDateNodeId } from "@notees/domain";

import { ClassPillsList } from "../ClassPillsList.js";
import { removeClassDissolvingLinks } from "../classRemoval.js";
import type { AnyClient } from "./shared.js";

/**
 * The node's own classes: pills with an × that unassigns (class.unassign),
 * a right-click color-swatch menu (object.update color), and a "+ Add class"
 * ghost pill opening the node-selector popup (assignClass): the pills
 * ride ClassPillsList — the instance-of relation's mutations passed as
 * arguments, the row chrome (the label) stays here.
 *
 * Date-chain class lock (SCHEMA.md "Datetime"): a date node's class set is
 * fixed to its precision's system class — the row renders read-only (no
 * Add-class pill, no ×, no drag-sort) on date nodes.
 */
export function ClassesRow({
  client,
  nodeId,
  classIds,
  onOpenPage,
}: {
  client: AnyClient;
  nodeId: string;
  classIds: string[];
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const locked = parseDateNodeId(nodeId) !== null;
  return (
    <div className="node-metadata-row nt-classes-row">
      <div className="section-label">Classes:</div>
      <ClassPillsList
        client={client}
        nodeId={nodeId}
        query={classIds}
        add={(classId) => void client.assignClass(nodeId, classId)}
        remove={(classId) => void removeClassDissolvingLinks(client, nodeId, classId)}
        reorder={(ordered) => void client.reorderClasses(nodeId, ordered)}
        onOpenPage={onOpenPage}
        readOnly={locked}
      />
    </div>
  );
}
