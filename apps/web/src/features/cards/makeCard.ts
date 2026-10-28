/**
 * makeCard — the "Make memorization card" write behind the node context
 * menu (blocks and pages alike — a card is any node classed `card`, the
 * hub's membership rule). Composes the canonical class-assign write path
 * (client.assignClass — the same OR-Set add carrier the class pills, the
 * capture flows, and the selection bar issue).
 *
 * Assign-if-absent: the current membership is read first and an existing
 * card class membership emits NO write — OR-Set add-wins would make a
 * re-add semantically safe, but a silent re-run beats a redundant op.
 * A class node is refused loud — the card class classifies things; a
 * class itself never becomes a card. Date-chain nodes are equally refused:
 * their class set is precision-locked (SCHEMA.md "Datetime") and the
 * write would fail at the applier anyway.
 */

import { parseDateNodeId, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client/index.js";

/** The client surface makeCard needs — both client classes satisfy it. */
export interface MakeCardClient {
  getNode(id: string): ClientNode | undefined;
  assignClass(id: string, classId: string): Promise<void>;
}

/** Class-assign the card system class to the node, unless it already is one. */
export async function makeCard(client: MakeCardClient, nodeId: string): Promise<void> {
  const node = client.getNode(nodeId);
  if (node === undefined) throw new Error(`makeCard: node ${nodeId} not found`);
  if (node.isClass) throw new Error("makeCard: a class node cannot be a memorization card");
  if (parseDateNodeId(node.id) !== null) {
    throw new Error("makeCard: a date-chain node's class set is precision-locked");
  }
  if (node.classIds.includes(SYSTEM_CLASS_UUIDS.card)) return;
  await client.assignClass(nodeId, SYSTEM_CLASS_UUIDS.card);
}
