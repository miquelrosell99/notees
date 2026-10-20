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
      // Node-backed: a fresh carrier block child holds the text.
      const carrier = await client.createObject({
        parentId: nodeId,
        contentAst: [{ type: "text", text: "" }],
      });
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
