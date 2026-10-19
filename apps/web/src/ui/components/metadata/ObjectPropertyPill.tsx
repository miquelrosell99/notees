import type { ReactNode } from "react";

import type { EffectiveProperty } from "@/core/workspace-client.js";

import { NodePill } from "../NodePills.js";
import type { AnyClient } from "./shared.js";

/**
 * One value pill of a multi-value node-typed property (the multi branch of
 * ObjectPropertyRow): the broken-reference honest state (PB1 — the raw id
 * in a dashed pill, never a silently empty chip) or the shared NodePill
 * tinted with the linked node's effective color. Pure move from the
 * historical MetadataSection.tsx.
 */
export function ObjectPropertyPill({
  client,
  propertySchemaId,
  row,
  valueRef,
  isAssetTarget,
  readOnly,
  onOpenPage,
  unlink,
  pillLabel,
  annotationsToggle,
  qualifierOf,
}: {
  client: AnyClient;
  propertySchemaId: string;
  row: EffectiveProperty;
  valueRef: string;
  isAssetTarget: boolean;
  readOnly: boolean;
  onOpenPage?: ((pageId: string) => void) | undefined;
  unlink: (idx: number) => void;
  pillLabel: (ref: string) => string;
  annotationsToggle: (ref: string) => ReactNode;
  qualifierOf: (row: EffectiveProperty, ref: string) => ReactNode;
}) {
  const ref = valueRef;
  const removeLabel = `Remove ${pillLabel(ref)}`;
  const download = () => {
    const info = client.getAssetInfo(ref);
    if (info !== undefined) void client.downloadAsset(info.assetId);
  };
  const linkedNode = client.getNode(ref);
  // PB1 (SCHEMA.md "Broken references"): the value survives a
  // deleted/trashed target — render the broken state honestly: the
  // raw id in a dashed pill (the broken-mention policy), never a
  // silently empty chip.
  const broken = linkedNode === undefined;
  const trailing = (
    <>
      {annotationsToggle(ref)}
      {qualifierOf(row, ref)}
    </>
  );
  if (broken) {
    return (
      <span
        key={`${propertySchemaId}:${row.idx}`}
        className={
          row.source === "default"
            ? "pill pill--default"
            : "pill pill--hover-reveal-right pill--broken"
        }
        title={`Broken reference: ${ref}`}
      >
        <span className="pill__text nt-chip-label nt-chip-label--broken">
          <code>{ref}</code>
        </span>
        {row.source === "authored" && (
          <button
            type="button"
            className="pill__right-button nt-chip-remove"
            aria-label={removeLabel}
            onClick={() => void unlink(row.idx)}
          >
            ×
          </button>
        )}
        {trailing}
      </span>
    );
  }
  // The value pill — the SAME element the nodeview classes list
  // renders (NodePill), tinted with the linked node's effective
  // color (own color, else its classes'). Every resolved value rides
  // one compact pill — never the node's subtree (the editable-block
  // treatment is the TEXT property row's contract, not object
  // values').
  return (
    <NodePill
      key={`${propertySchemaId}:${row.idx}`}
      color={client.effectiveNodeColor(linkedNode)}
      icon={linkedNode.icon}
      label={pillLabel(ref)}
      className={row.source === "default" ? "pill--default" : ""}
      hoverReveal={row.source !== "default"}
      onOpen={isAssetTarget ? download : () => onOpenPage?.(ref)}
      onRemove={!readOnly && row.source === "authored" ? () => void unlink(row.idx) : undefined}
      removeLabel={removeLabel}
      trailing={trailing}
    />
  );
}
