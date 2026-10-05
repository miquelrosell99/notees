/**
 * textCarrier.ts — the text-property carrier contract (§34.80).
 *
 * A text property's value is node-backed: the value references a carrier
 * block (a child of the node carrying the property). The metadata panel
 * renders those carriers as an editable blocks list and provides this
 * context so the block editor can apply the property's Enter semantics:
 *
 *  - multi-value property: Enter creates a SIBLING block and registers it as
 *    the next property value (one block per value, values as siblings);
 *  - single-value property: Enter creates a CHILD block of the carrier —
 *    the value itself is one block whose children are its lines.
 *
 * The page body (no provider) keeps the ordinary outliner Enter semantics.
 */

import { createContext } from "react";

import type { EffectiveProperty } from "@/core/workspace-client.js";

/** The minimal write surface the carrier registration needs — satisfied by
 *  the outliner client, WorkspaceClient, and WorkerClient alike. */
export interface CarrierWriter {
  getEffectiveProperties(nodeId: string): EffectiveProperty[];
  setProperty(
    nodeId: string,
    propertySchemaId: string,
    value: unknown,
    idx?: number,
  ): Promise<void>;
}

export interface CarrierInfo {
  /** The node carrying the property (the carrier block's parent). */
  ownerId: string;
  propertySchemaId: string;
  /** Multi: Enter registers the new sibling as a value. Single: Enter nests. */
  multi: boolean;
}

export interface CarrierEnterContextValue {
  /** The carrier info when `blockId` IS one of this property's carriers. */
  carrierOf: (blockId: string) => CarrierInfo | null;
}

export const CarrierEnterContext = createContext<CarrierEnterContextValue | null>(null);

/**
 * Register a freshly created block as the next value of the carrier's
 * property (the multi-Enter path). Idx allocation re-reads the authored rows
 * at commit time so rapid Enters cannot collide.
 */
export function registerCarrierValue(
  client: CarrierWriter,
  carrier: CarrierInfo,
  newBlockId: string,
): void {
  const rows = client
    .getEffectiveProperties(carrier.ownerId)
    .filter(
      (row) => row.propertySchemaId === carrier.propertySchemaId && row.source === "authored",
    );
  const nextIdx = rows.length > 0 ? Math.max(...rows.map((row) => row.idx)) + 1 : 0;
  void client.setProperty(carrier.ownerId, carrier.propertySchemaId, { nodeId: newBlockId }, nextIdx);
}
