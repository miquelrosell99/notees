/**
 * propertyValueInit — the placeholder-value write that makes a newly added
 * property row appear on a node (the panel's "+ Add property" flow). Moved
 * out of AddPropertyRow so the S1 creation modal's host can run the same
 * follow-up after a create.
 *
 * The placeholder is type-shaped (PG6): a boolean starts false→true, a
 * number 0, a text property gets a fresh empty carrier block (the
 * node-backed convention), a datetime links today (local midnight, not
 * UTC). url/email/select/multi_select/object/image have no sensible empty
 * value — the row's own editor prompts on first edit.
 */

import { todayIsoLocal } from "../calendar/calendarViewUtils.js";

import type { AnyClient } from "./shared.js";

/**
 * Carrier ids minted by THIS placeholder init and not yet "settled". The
 * panel's "+ Add property" flow never moves focus into the text row, so
 * TextPropertyRow's focus-guarded auto-unset pass cannot see that the
 * contentless placeholder was just created for the user to type into — the
 * row consults this set and skips a pending carrier until content lands or
 * the user leaves the row (the row's blur pass clears the marks and unsets
 * an abandoned empty placeholder). Session-local, never an op.
 */
const pendingTextCarriers = new Set<string>();

/** The pass's read: is this carrier a placeholder awaiting first content? */
export function isPendingTextCarrier(carrierId: string): boolean {
  return pendingTextCarriers.has(carrierId);
}

/** Settled (content landed, or the row blur pass is about to re-judge it). */
export function clearPendingTextCarrier(carrierId: string): void {
  pendingTextCarriers.delete(carrierId);
}

export async function initializePropertyValue(
  client: AnyClient,
  nodeId: string,
  schemaId: string,
  type: string,
): Promise<void> {
  switch (type) {
    case "boolean":
      await client.setProperty(nodeId, schemaId, true, 0);
      return;
    case "number":
      await client.setProperty(nodeId, schemaId, 0, 0);
      return;
    case "text": {
      // Node-backed: a fresh carrier block child holds the text. Mark it
      // pending — the panel add flow leaves focus outside the row, so the
      // auto-unset pass needs this to tell the placeholder from a dead one.
      const carrier = await client.createObject({
        parentId: nodeId,
        contentAst: [{ type: "text", text: "" }],
      });
      pendingTextCarriers.add(carrier);
      await client.setProperty(nodeId, schemaId, { nodeId: carrier }, 0);
      return;
    }
    case "datetime": {
      // Local midnight, not UTC — the "today" default must match the
      // user's calendar day. Full-day: the point carries no time.
      const dayId = await client.ensureDateChain(todayIsoLocal());
      await client.setProperty(nodeId, schemaId, { nodeId: dayId }, 0);
      return;
    }
    default:
      return;
  }
}
