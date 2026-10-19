import { useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { Button } from "../../ui/components/ui/Button.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { AssetUploadModal } from "../modals/AssetUploadModal.js";
import { AssetItemRow } from "./AssetItemRow.js";
import type { AnyClient } from "./shared.js";
import { nodeRefOf } from "./shared.js";

/**
 * One asset-typed property (the `asset` type — a node reference whose target
 * must carry the ASSET class, the filter implicit in the type): the values
 * render as a list of the linked assets (thumbnail + file name + remove) and
 * the row carries TWO authoring buttons — Upload (the AssetUploadModal
 * flow: CAS upload → asset node → the property value) and Link (the node
 * picker scoped to asset-classed nodes, create disabled). Multi rows keep
 * both buttons at the list's bottom; a single-value row renders the buttons
 * only while empty — replacement goes through clearing first.
 */
export function AssetPropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  multi,
  rows,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
  /** Read-only projection: the asset list renders without actions. */
  readOnly = false,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  rows: EffectiveProperty[];
  bare?: boolean;
  readOnly?: boolean | undefined;
}) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadButtonRef = useRef<HTMLButtonElement | null>(null);
  const linkButtonRef = useRef<HTMLButtonElement | null>(null);

  const items = rows
    .map((row) => ({ row, ref: nodeRefOf(row.value) }))
    .filter((item): item is { row: EffectiveProperty; ref: string } => item.ref !== null)
    .sort((a, b) => a.row.idx - b.row.idx);
  const authoredIdx = rows.filter((row) => row.source === "authored").map((row) => row.idx);
  // Per-slot write pattern: append at the next free idx (0 shadows a default).
  const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;

  const linkAsset = async (target: string): Promise<void> => {
    setError(null);
    try {
      await client.setProperty(nodeId, propertySchemaId, { nodeId: target }, nextIdx);
      setPickerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** The modal's completion: link the uploaded asset node at the next slot. */
  const linkUploadedAsset = async (assetNodeId: string): Promise<void> => {
    setError(null);
    try {
      await client.setProperty(nodeId, propertySchemaId, { nodeId: assetNodeId }, nextIdx);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const classSourced = rows.some((row) => row.boundBy !== null);

  return (
    <li
      className={
        allDefault
          ? "nt-property nt-property-default nt-property-asset node-metadata-row"
          : "nt-property nt-property-asset node-metadata-row"
      }
    >
      {!bare && (
        <>
          <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
        </>
      )}
      <div className="nt-property-assets">
        {items.length > 0 && (
          <ul className="nt-asset-list">
            {items.map(({ row, ref }) => (
              <AssetItemRow
                key={`${propertySchemaId}:${row.idx}`}
                client={client}
                assetRef={ref}
                dimmed={row.source === "default"}
                removable={!readOnly && row.source === "authored"}
                onRemove={() => void client.unsetProperty(nodeId, propertySchemaId, row.idx)}
              />
            ))}
          </ul>
        )}
        {!readOnly && (multi || items.length === 0) && (
          <div className="nt-asset-actions">
            <Button
              ref={uploadButtonRef}
              variant="ghost"
              size="sm"
              icon="mdi-upload"
              onClick={() => setUploadOpen(true)}
            >
              Upload
            </Button>
            <Button
              ref={linkButtonRef}
              variant="ghost"
              size="sm"
              icon="mdi-link-variant"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((open) => !open)}
            >
              Link
            </Button>
          </div>
        )}
      </div>
      {pickerOpen && (
        <NodeSelector
          client={client}
          searchMode="all"
          classFilters={[SYSTEM_CLASS_UUIDS.asset]}
          allowCreate={false}
          excludeNodeId={nodeId}
          anchorEl={linkButtonRef.current}
          onClose={() => setPickerOpen(false)}
          searchPlaceholder={`Search ${label}`}
          onAdd={(node) => void linkAsset(node.id)}
        />
      )}
      {uploadOpen && (
        <AssetUploadModal
          isOpen
          client={client}
          assetClassId={SYSTEM_CLASS_UUIDS.asset}
          onClose={() => setUploadOpen(false)}
          onUploaded={(assetNodeId) => void linkUploadedAsset(assetNodeId)}
        />
      )}
      {error !== null && (
        <p role="alert" className="nt-picker-error">
          {error}
        </p>
      )}
    </li>
  );
}
