/**
 * The (value → carrier) resolution shared by every consumer that must read a
 * text property value in BOTH storage shapes: the node-backed carrier ref
 * (`{ "nodeId": … }` — the panel's edit path mints one per value, see
 * SCHEMA.md "Node-backed text properties") and the legacy scalar string
 * (quick-create / regenerate / auto-write paths author plain strings; a
 * bare uuid-shaped string is ALSO a legacy ref encoding). Extracted from
 * TextPropertyRow (its original home) so the citekey tracking engine
 * (`features/sources/citekeyValue.ts`) reads carriers exactly the way the
 * panel renders them — one resolution contract, both consumers.
 */

import { rendersAsInlineBlock } from "@notees/domain";

import type { AnyClient } from "../collection/types.js";
import { parentlessBlockResolverOf, parentRenderFacts } from "../../ui/renderStateLabel.js";

/** One property value's carrier resolution (the metadata panel's branches). */
export type CarrierState =
  | { kind: "carrier"; id: string }
  | { kind: "dead" }
  | { kind: "scalar" };

export function carrierStateOf(client: AnyClient, value: unknown): CarrierState {
  const rawRef =
    typeof value === "object" && value !== null && "nodeId" in (value as Record<string, unknown>)
      ? String((value as { nodeId: unknown }).nodeId ?? "")
      : typeof value === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? value
        : null;
  if (rawRef !== null) {
    const node = client.getNode(rawRef);
    if (
      node !== undefined &&
      rendersAsInlineBlock(node, parentRenderFacts(client, node), parentlessBlockResolverOf(client))
    ) {
      return { kind: "carrier", id: rawRef };
    }
    return { kind: "dead" };
  }
  return { kind: "scalar" };
}
