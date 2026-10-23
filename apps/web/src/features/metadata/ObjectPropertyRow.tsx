import { useRef, useState } from "react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { EffectiveProperty } from "@/core/workspace-client/index.js";

import { AnnotationsSection } from "../../ui/AnnotationsSection.js";
import { labelFromClient } from "../../ui/dateDisplay.js";
import { AddPill } from "../../components/ui/fleet/AddPill.js";
import { NodePill } from "./NodePills.js";
import { NodeSelector } from "../pickers/NodeSelector.js";
import { AssetUploadModal } from "../modals/AssetUploadModal.js";
import { ObjectPropertyPill } from "./ObjectPropertyPill.js";
import { PropertySelectCell } from "./PropertySelectCell.js";
import { QualifierRange } from "./QualifierRange.js";
import type { AnyClient } from "./shared.js";
import { isAssetClass, nodeRefOf, resolveTargetClassIds } from "./shared.js";
import { qualifierIsoOf } from "./datetimeValue.js";

/**
 * One node-typed property: pills of the linked nodes + the add/upload picker.
 * `rows` are the effective rows of this schema on the node (authored pills
 * and, dimmed, any derived default) — empty when the binding has no values
 * yet, so the add affordance is reachable before the first link.
 */
export function ObjectPropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  multi,
  bindingFilter,
  rows,
  onOpenPage,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
  /** Read-only projection: values render as static pills, no picker. */
  readOnly = false,
  /** Extra li class (the R4 ineligible rendering — " nt-property-ineligible"). */
  rowClassName = "",
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  /** The class binding's targetClassFilter (seed fallback may carry names). */
  bindingFilter: string[] | null;
  rows: EffectiveProperty[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  bare?: boolean;
  readOnly?: boolean | undefined;
  rowClassName?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The asset upload modal (drag-drop + preview + progress). */
  const [uploadOpen, setUploadOpen] = useState(false);
  /** Pill ref whose annotations section is open (one at a time), null = none. */
  const [annotatingRef, setAnnotatingRef] = useState<string | null>(null);
  // HTMLElement: the multi branch anchors at the Add pill (a button), the
  // single branch at the select trigger (a div[role=button]).
  const addButtonRef = useRef<HTMLElement | null>(null);

  const targetClassIds = resolveTargetClassIds(client, propertySchemaId, bindingFilter);
  const assetClassId = targetClassIds?.find((id) => isAssetClass(client, id));
  const isAssetTarget = assetClassId !== undefined;
  const schemaRow = client.listPropertySchemas().find((s) => s.id === propertySchemaId);
  const dateQualified = schemaRow?.dateQualified === true;

  const pills = rows
    .map((row) => ({ row, ref: nodeRefOf(row.value) }))
    .filter((pill): pill is { row: EffectiveProperty; ref: string } => pill.ref !== null)
    .sort((a, b) => a.row.idx - b.row.idx);
  const linkedIds = new Set(pills.map((pill) => pill.ref));
  const authoredIdx = rows.filter((row) => row.source === "authored").map((row) => row.idx);
  // Per-slot write pattern: append at the next free idx (0 shadows a default).
  const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;

  const pillLabel = (ref: string): string => {
    if (isAssetTarget) {
      const info = client.getAssetInfo(ref);
      if (info !== undefined) return info.originalName;
    }
    return labelFromClient(client, ref) ?? "Untitled";
  };

  const linkNode = async (target: string, idx: number = nextIdx): Promise<void> => {
    // Multi appends at the next free idx; single-value REPLACES the existing
    // authored slot (the selection dropdown re-picks in place).
    await client.setProperty(nodeId, propertySchemaId, { nodeId: target }, idx);
    // A cover value written through the generic panel still classes
    // the target as an asset (explicit ops — every client converges on
    // classIds; the property value stays the authority).
    if (propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover) {
      const classIds = client.getNode(target)?.classIds ?? [];
      if (!classIds.includes(SYSTEM_CLASS_UUIDS.asset)) {
        await client.assignClass(target, SYSTEM_CLASS_UUIDS.asset);
      }
    }
    setPickerOpen(false);
  };

  const unlink = async (idx: number): Promise<void> => {
    await client.unsetProperty(nodeId, propertySchemaId, idx);
  };

  /** The modal's completion: link the uploaded asset node. */
  const linkUploadedAsset = async (assetNodeId: string): Promise<void> => {
    await client.setProperty(nodeId, propertySchemaId, { nodeId: assetNodeId }, nextIdx);
    // A cover value written through the generic panel still gives
    // the node its asset identity (explicit ops — convergent).
    if (propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover) {
      const classIds = client.getNode(assetNodeId)?.classIds ?? [];
      if (!classIds.includes(SYSTEM_CLASS_UUIDS.asset)) {
        await client.assignClass(assetNodeId, SYSTEM_CLASS_UUIDS.asset);
      }
    }
    setPickerOpen(false);
  };

  // No rows (bound, unvalued) is not a default state — no hint.
  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const classSourced = rows.some((row) => row.boundBy !== null);

  const qualifierOf = (row: EffectiveProperty, ref: string) =>
    dateQualified ? (
      <QualifierRange
        client={client}
        start={qualifierIsoOf(row.metadata?.startDate)}
        end={qualifierIsoOf(row.metadata?.endDate)}
        ariaLabel={pillLabel(ref)}
        onCommit={(startIso, endIso) => {
          const metadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
          if (startIso === "") delete metadata.startDate;
          else metadata.startDate = startIso;
          if (endIso === "") delete metadata.endDate;
          else metadata.endDate = endIso;
          void client.setProperty(nodeId, propertySchemaId, row.value, row.idx, metadata);
        }}
      />
    ) : null;

  /** The ❝ annotations toggle — an asset-pill primary action, never hidden. */
  const annotationsToggle = (ref: string) =>
    !readOnly && isAssetTarget ? (
      <button
        type="button"
        className="pill__right-button nt-chip-annotations"
        title="Annotations"
        aria-label={`Annotate ${pillLabel(ref)}`}
        aria-expanded={annotatingRef === ref}
        onClick={() => setAnnotatingRef((cur) => (cur === ref ? null : ref))}
      >
        ❝
      </button>
    ) : null;

  // Single-value: the selection dropdown (owner 2026-10-09) — the content
  // area shows the selected node as a read-only block row, never a pill;
  // empty renders the "Select" placeholder across the full value cell.
  if (multi === false) {
    // An authored value shadows a derived default at another slot — the
    // dropdown shows the authored one.
    const single = [...pills].reverse().find((pill) => pill.row.source === "authored") ?? pills[0];
    const singleRow = single?.row;
    const singleRef = single?.ref ?? null;
    if (readOnly) {
      // Read-only projection: the value rides one static pill (the same
      // NodePill element, minus every mutation affordance); empty renders
      // nothing — the row hides via the host's hideWhenEmpty pass.
      const linked = singleRef !== null ? client.getNode(singleRef) : undefined;
      return (
        <li
          className={
            allDefault
              ? `nt-property nt-property-default nt-property-object node-metadata-row${rowClassName}`
              : `nt-property nt-property-object node-metadata-row${rowClassName}`
          }
        >
          {!bare && (
            <>
              <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
            </>
          )}
          {singleRef !== null && linked === undefined ? (
            <span className="nt-property-chips node-metadata-pills">
              <span className="pill pill--broken" title={`Broken reference: ${singleRef}`}>
                <span className="pill__text nt-chip-label nt-chip-label--broken">
                  <code>{singleRef}</code>
                </span>
              </span>
            </span>
          ) : singleRef !== null && linked !== undefined ? (
            <span className="nt-property-chips node-metadata-pills">
              <NodePill
                color={client.effectiveNodeColor(linked)}
                icon={linked.icon}
                label={labelFromClient(client, singleRef) ?? "Untitled"}
                onOpen={() => onOpenPage?.(singleRef)}
              />
            </span>
          ) : null}
        </li>
      );
    }
    const replaceIdx =
      singleRow !== undefined && singleRow.source === "authored" ? singleRow.idx : nextIdx;
    return (
      <li
        className={
          allDefault
            ? `nt-property nt-property-default nt-property-object node-metadata-row${rowClassName}`
            : `nt-property nt-property-object node-metadata-row${rowClassName}`
        }
      >
        {!bare && (
          <>
            <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
          </>
        )}
        <PropertySelectCell
          client={client}
          valueRef={singleRef}
          ariaLabel={`Set ${label}`}
          placeholder="Select"
          isOpen={pickerOpen}
          onToggle={(anchor) => {
            addButtonRef.current = anchor;
            setPickerOpen((open) => !open);
          }}
          clearLabel={`Clear ${label}`}
          onClear={
            singleRow !== undefined && singleRow.source === "authored"
              ? () => void unlink(singleRow.idx)
              : undefined
          }
          onNavigate={
            singleRef !== null
              ? () => onOpenPage?.(singleRef)
              : undefined
          }
          navigateLabel={
            singleRef !== null
              ? `Open ${labelFromClient(client, singleRef) ?? "Untitled"}`
              : undefined
          }
          trailing={
            <>
              {singleRef !== null && annotationsToggle(singleRef)}
              {single !== undefined && qualifierOf(single.row, single.ref)}
            </>
          }
        >
          {singleRef !== null && (() => {
            const linked = client.getNode(singleRef);
            if (linked === undefined) return null; // broken — the cell shows it
            // The PLAIN display text (owner 2026-10-20): the dropdown's
            // content names the selected node like a select option or a
            // date value — never a pill (the NodePill chip retired here).
            return pillLabel(singleRef);
          })()}
        </PropertySelectCell>
        {annotatingRef !== null && (
          <AnnotationsSection client={client} assetId={annotatingRef} onOpenPage={onOpenPage} />
        )}
        {pickerOpen && (
          <NodeSelector
            client={client}
            searchMode={isAssetTarget ? "all" : "pages"}
            classFilters={targetClassIds ?? undefined}
            excludeNodeId={nodeId}
            anchorEl={addButtonRef.current}
            onClose={() => setPickerOpen(false)}
            searchPlaceholder={`Search ${label}`}
            onAdd={(node) => void linkNode(node.id, replaceIdx)}
            // Asset targets: the create row IS the upload action (allowCreate
            // must stay true or alwaysShowCreate below can never render — the
            // row answers "Upload file…" via onCreateNew, never a bare create).
            alwaysShowCreate={isAssetTarget}
            createLabel={isAssetTarget ? "Upload file…" : undefined}
            onCreateNew={
              isAssetTarget
                ? () => {
                    // The upload runs in the AssetUploadModal
                    // (drag-drop + preview + progress), not a bare file input.
                    setPickerOpen(false);
                    setUploadOpen(true);
                  }
                : (name) =>
                    client.createObject({
                      isEmbedded: false,
                      name,
                      ...(targetClassIds !== null ? { classIds: targetClassIds } : {}),
                    })
            }
          />
        )}
        {uploadOpen && assetClassId !== undefined && (
          <AssetUploadModal
            isOpen
            client={client}
            assetClassId={assetClassId}
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

  return (
    <li
      className={
        allDefault
          ? `nt-property nt-property-default nt-property-object node-metadata-row${rowClassName}`
          : `nt-property nt-property-object node-metadata-row${rowClassName}`
      }
    >
      {!bare && (
        <>
          <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}{classSourced && <span className="nt-property-hint" title="From a class">C</span>}</span>
        </>
      )}
      <span className="nt-property-chips node-metadata-pills">
        {pills.map(({ row, ref }) => (
          <ObjectPropertyPill
            key={`${propertySchemaId}:${row.idx}`}
            client={client}
            propertySchemaId={propertySchemaId}
            row={row}
            valueRef={ref}
            isAssetTarget={isAssetTarget}
            readOnly={readOnly}
            onOpenPage={onOpenPage}
            unlink={unlink}
            pillLabel={pillLabel}
            annotationsToggle={annotationsToggle}
            qualifierOf={qualifierOf}
          />
        ))}
        {!readOnly && (
          <AddPill
            ref={(element) => {
              addButtonRef.current = element;
            }}
            label="Add"
            aria-expanded={pickerOpen}
            onClick={(element) => {
              addButtonRef.current = element;
              setPickerOpen((open) => !open);
            }}
          />
        )}
      </span>
      {annotatingRef !== null && (
        <AnnotationsSection client={client} assetId={annotatingRef} onOpenPage={onOpenPage} />
      )}
      {pickerOpen && (
        <NodeSelector
          client={client}
          searchMode={isAssetTarget ? "all" : "pages"}
          classFilters={targetClassIds ?? undefined}
          excludeNodeId={nodeId}
          anchorEl={addButtonRef.current}
          onClose={() => setPickerOpen(false)}
          searchPlaceholder={`Search ${label}`}
          onAdd={(node) => void linkNode(node.id)}
          // Asset targets: the create row IS the upload action (allowCreate
          // must stay true or alwaysShowCreate below can never render — the
          // row answers "Upload file…" via onCreateNew, never a bare create).
          alwaysShowCreate={isAssetTarget}
          createLabel={isAssetTarget ? "Upload file…" : undefined}
          onCreateNew={
            isAssetTarget
              ? () => {
                  // The upload runs in the AssetUploadModal
                  // (drag-drop + preview + progress), not a bare file input.
                  setPickerOpen(false);
                  setUploadOpen(true);
                }
              : (name) =>
                  client.createObject({
                    isEmbedded: false,
                    name,
                    ...(targetClassIds !== null ? { classIds: targetClassIds } : {}),
                  })
          }
        />
      )}
      {uploadOpen && assetClassId !== undefined && (
        <AssetUploadModal
          isOpen
          client={client}
          assetClassId={assetClassId}
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
