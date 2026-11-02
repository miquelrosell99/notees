import { useMemo, useRef, useState } from "react";
import { Icon } from "../../ui/Icon.js";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { Button } from "../../components/ui/kit/Button.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { AssetUploadModal } from "../modals/AssetUploadModal.js";
import { isCitationFamilyClass, readSourceSettings } from "../modals/quickCreate.js";
import { resolveSourceInput } from "../sources/resolver.js";
import { resolveCoordinates } from "../sources/resolveCoordinates.js";
import { AssetItemRow } from "./AssetItemRow.js";
import type { AnyClient } from "./shared.js";
import { nodeRefOf } from "./shared.js";

/**
 * One asset-typed property (the `asset` type — a node reference whose target
 * must carry the ASSET class, the filter implicit in the type): the values
 * render as a list of the linked assets (thumbnail + file name + remove) and
 * the row carries the authoring buttons — Upload (the AssetUploadModal
 * flow: CAS upload → asset node → the property value), Link (the node
 * picker scoped to asset-classed nodes, create disabled), and — ONLY on a
 * source node's `attachments` row, with the resolver on and online — Fetch
 * (one-click open-access PDF: resolve the source's DOI/PMID through the
 * metadata resolver, follow the Unpaywall OA link, download the bytes
 * browser-side, CAS-upload + link; the honest errors cover no-identifier,
 * no-OA-location, blocked downloads, and resolver failures). Multi rows keep
 * the buttons at the list's bottom; a single-value row renders the buttons
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
  /** Extra li class (the R4 ineligible rendering — " nt-property-ineligible"). */
  rowClassName = "",
  /** The host knows the property is class-supplied even when rows carry no boundBy
   *  (the empty assigned/bound reduction) — the from-class badge rides this. */
  classBound = false,
  /** The property-header icon (effectivePropertyIcon). */
  icon,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  rows: EffectiveProperty[];
  bare?: boolean;
  readOnly?: boolean | undefined;
  rowClassName?: string;
  classBound?: boolean;
  icon: string;
}) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const uploadButtonRef = useRef<HTMLButtonElement | null>(null);
  const linkButtonRef = useRef<HTMLButtonElement | null>(null);
  const fetchButtonRef = useRef<HTMLButtonElement | null>(null);

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

  // The Fetch button's surface gate: the seeded attachments row on a
  // source-family node, resolver on, coordinates registered (online), and
  // the client carries the asset + effective-read capabilities the flow
  // needs. Everything else falls back to Upload/Link.
  const sourceAttachments =
    propertySchemaId === SYSTEM_PROPERTY_UUIDS.attachments &&
    readSourceSettings(client).resolverEnabled &&
    resolveCoordinates() !== null &&
    client.getEffectiveProperties !== undefined &&
    client.uploadAsset !== undefined &&
    client.attachAsset !== undefined;
  const fetchEligible = useMemo(() => {
    if (!sourceAttachments) return false;
    const node = client.getNode?.(nodeId);
    if (node === undefined) return false;
    return node.classIds.some((classId) => isCitationFamilyClass(client, classId));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the eligibility reads live client state.
  }, [sourceAttachments, client, nodeId]);

  /** The first resolvable identifier on the source (doi → pmid → isbn). */
  const identifierTextOf = (): string | null => {
    const effective = client.getEffectiveProperties?.(nodeId) ?? [];
    for (const schemaId of [
      SYSTEM_PROPERTY_UUIDS.doi,
      SYSTEM_PROPERTY_UUIDS.pmid,
      SYSTEM_PROPERTY_UUIDS.isbn,
    ]) {
      const row = effective.find(
        (entry) => entry.propertySchemaId === schemaId && typeof entry.value === "string",
      );
      const text = row?.value as string | undefined;
      if (text !== undefined && text.trim() !== "") return text.trim();
    }
    return null;
  };

  const filenameOf = (url: string): string => {
    const base = url.split("?")[0]!.split("/").filter((part) => part !== "").pop() ?? "";
    return base.toLowerCase().endsWith(".pdf") ? base : "open-access.pdf";
  };

  const fetchOpenAccess = async (): Promise<void> => {
    const coords = resolveCoordinates();
    if (coords === null || fetching) return;
    setFetching(true);
    setError(null);
    try {
      const identifier = identifierTextOf();
      if (identifier === null) {
        setError("This source has no DOI, PMID, or ISBN to fetch with.");
        return;
      }
      const record = await resolveSourceInput(coords.serverUrl, coords.credential, identifier);
      const pdfUrl = record.pdf?.url;
      if (pdfUrl === undefined) {
        setError("No open-access PDF found for this source.");
        return;
      }
      const download = await fetch(pdfUrl);
      if (!download.ok) {
        setError(`The PDF download was refused (HTTP ${download.status}).`);
        return;
      }
      const blob = await download.blob();
      // The AssetUploadModal pipeline, headless: CAS upload → asset node →
      // attach → link at the next free slot.
      const uploaded = await client.uploadAsset!(blob, filenameOf(pdfUrl));
      const assetNodeId = await client.createObject({
        isEmbedded: false,
        name: uploaded.originalName,
        classIds: [SYSTEM_CLASS_UUIDS.asset],
      });
      await client.attachAsset!(assetNodeId, uploaded);
      await client.setProperty(nodeId, propertySchemaId, { nodeId: assetNodeId }, nextIdx);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  };

  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const classSourced = rows.some((row) => row.boundBy !== null) || classBound;

  return (
    <li
      className={
        allDefault
          ? `nt-property nt-property-default nt-property-asset node-metadata-row${rowClassName}`
          : `nt-property nt-property-asset node-metadata-row${rowClassName}`
      }
    >
      {!bare && (
        <>
          <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}><Icon path={icon} size={0.8} className="nt-property-name__icon" />{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
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
            {fetchEligible && (
              <Button
                ref={fetchButtonRef}
                variant="ghost"
                size="sm"
                icon="mdi-cloud-download-outline"
                loading={fetching}
                disabled={fetching}
                onClick={() => void fetchOpenAccess()}
              >
                Fetch
              </Button>
            )}
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
