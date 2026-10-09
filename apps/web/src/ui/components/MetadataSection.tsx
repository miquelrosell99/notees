/**
 * MetadataSection — the page's effective-properties panel (renamed
 * "Metadata", owner 2026-10-09).
 *
 * Rows:
 *  - the panel's FIRST section is the aliases row (relocated from the
 *    title-row AliasesButton): every alias of the page as pills with an ×
 *    each + "+ Add alias" (the backward write over the picker's pick);
 *  - the node's classes as colored pills (× unassigns; right-click opens the
 *    color-swatch menu) + a "+ Add class" ghost pill opening the ported
 *    node-selector popup (search / create / pick, client.assignClass);
 *  - MULTI-value node-typed values render as pills — the same NodePill
 *    element the nodeview classes list renders, tinted with the linked
 *    node's effective color; the picker is the ported NodeSelector popup
 *    (search + create, filtered by the schema's target classes, upload for
 *    asset targets);
 *  - SINGLE-value node-typed and date values render as the full-width
 *    selection dropdown (PropertySelectCell): the content area shows the
 *    selected node as a read-only block row (the date's display name —
 *    never a pill), empty shows the muted "Select" placeholder; the picker
 *    (NodeSelector / DatePickerPopup) anchors at the trigger, the clear
 *    affordance unsets the slot;
 *  - asset values render as the dedicated asset list (thumbnail + name +
 *    remove) with the Upload / Link authoring buttons (the asset picker is
 *    asset-scoped with create disabled; the upload runs in the
 *    AssetUploadModal);
 *  - select schemas with options render the ported options control
 *    (pills + picker), booleans a checkbox, everything else the minimal
 *    text editor; empty text cells render the full-width "Type something"
 *    placeholder input. Derived defaults stay dimmed with a "default" hint,
 *    authored values win, unbound survivors are marked.
 *  - the properties sidebar separates its properties with a hairline under
 *    each row; empty value cells keep the column's full width so they read
 *    as empty fields.
 *
 * The nt-* class hooks the tests assert on (.nt-properties-panel,
 * .nt-property-*, .nt-classes-row, …) are unchanged.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  parseDateNodeId,
  rendersAsInlineBlock,
  rendersWithDocumentChrome,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  type DatePrecision,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type {
  ClassBinding,
  ClientNode,
  EffectiveProperty,
  PropertyDisplay,
  WorkspaceClient,
} from "@/core/workspace-client.js";

import { AnnotationsSection } from "../AnnotationsSection.js";
import { todayIsoLocal } from "./calendarViewUtils.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { assetImageUrl } from "../views/assetThumbs.js";
import { Icon } from "../Icon.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { IconPickerPopup } from "./IconPickerPopup.js";
import { Checkbox } from "./ui/Checkbox.js";
import { AddPill } from "./ui/AddPill.js";
import { SelectionButton } from "./ui/SelectionButton.js";
import { ToggleSwitch } from "./ui/ToggleSwitch.js";
import { ColorPickerRow } from "./pickers/ColorPickerRow.js";
import { NodeContextMenu } from "./NodeContextMenu.js";
import { ReferenceSubtree } from "./ReferenceSubtree.js";
import { DatePickerPopup } from "./pickers/DatePickerPopup.js";
import { DateSlotControl, collectMarkedDates } from "./pickers/DateSlotControl.js";
import { RepeatPicker } from "./pickers/RepeatPicker.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import { SelectionPropertyControl, type SelectionOption } from "./pickers/SelectionPropertyControl.js";
import { AssetUploadModal } from "./modals/AssetUploadModal.js";
import { propertyLinkHref } from "../views/propertyDisplay.js";
import { cssColorFor, resolveCssColor } from "./ui/colorPresets.js";
import { ClassPillsList } from "./ClassPillsList.js";
import { NodePill } from "./NodePills.js";
import { ContextMenu } from "./ui/ContextMenu.js";
import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";
import { ColorButton } from "./ui/ColorButton.js";
import { PropertyView } from "./PropertyView.js";
import { PropertyConvertModal } from "./PropertyConvertModal.js";
import { PropertyHistoryModal } from "./PropertyHistoryModal.js";
import { TextPropertyRow } from "./TextPropertyRow.js";
import { AliasedNodeRow } from "./AliasedNodeRow.js";
import { AliasNodePicker } from "./AliasNodePicker.js";
import "./MetadataSection.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Text-round-trip of an authored/default value for the minimal editor. */
function toEditableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** Inverse: bare text stays a string; JSON-looking text parses (42, true, …). */
function fromEditableText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

/**
 * Node-typed property values carry the linked node's id as `{ "nodeId": … }`
 * (the shape the edge index projects, edges.ts); a bare string is accepted
 * leniently. Anything else is not a node reference.
 */
function nodeRefOf(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "object" && value !== null && "nodeId" in value) {
    const id = (value as { nodeId: unknown }).nodeId;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}

/** A date ref reads as its period label (2026 / 2026-09 / 2026-09-27). */
function dateLabelOf(ref: string): string {
  const parsed = parseDateNodeId(ref);
  if (parsed === null) return ref;
  const y = String(parsed.year).padStart(4, "0");
  if (parsed.precision === "year") return y;
  if (parsed.precision === "month") return `${y}-${String(parsed.month).padStart(2, "0")}`;
  return `${y}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
}

/** date_range value shape: { start, end } of date refs, either side open. */
interface DateRangeValue {
  start: string | null;
  end: string | null;
}

function rangeValueOf(value: unknown): DateRangeValue {
  if (typeof value !== "object" || value === null) return { start: null, end: null };
  const range = value as { start?: unknown; end?: unknown };
  return { start: nodeRefOf(range.start), end: nodeRefOf(range.end) };
}

/** The schema's commit ceiling for date values (day when unspecified). */
function precisionOf(schema: { datePrecision?: DatePrecision | null } | null | undefined): DatePrecision {
  return schema?.datePrecision ?? "day";
}

/**
 * Resolve a node-typed schema's targetClassFilter to class ids. The filter
 * entries may be class ids (property_schema row / registry binding, as the
 * server seeds them) or class names (the designed-seed fallback bindings) —
 * both are mapped through the class list; null means unconstrained.
 */
function resolveTargetClassIds(
  client: AnyClient,
  propertySchemaId: string,
  bindingFilter: string[] | null,
): string[] | null {
  const schemaRow = client.listPropertySchemas().find((s) => s.id === propertySchemaId);
  const filter = schemaRow?.targetClassFilter ?? bindingFilter;
  if (filter === null) return null;
  const classes = client.listClasses();
  const ids = filter
    .map((entry) => classes.find((c) => c.id === entry)?.id ?? classes.find((c) => c.name === entry)?.id)
    .filter((id): id is string => id !== undefined);
  return ids;
}

/** True when the class is the asset class (seeded id, or a class named "asset"). */
function isAssetClass(client: AnyClient, classId: string): boolean {
  return classId === SYSTEM_CLASS_UUIDS.asset || client.getNode(classId)?.name === "asset";
}

/**
 * Readable text on a class-color background: relative-luminance threshold
 * picks the black/white token. Stored colors are preset tokens (`sky`) or
 * custom hex, so resolve to a concrete hex before computing.
 */
function contrastFor(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(resolveCssColor(color).trim());
  if (match === null) return "var(--color-on-primary-container)";
  const rgb = parseInt(match[1]!, 16);
  const channel = (shift: number) => ((rgb >> shift) & 0xff) / 255;
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.45 ? "var(--color-black)" : "var(--color-white)";
}

/**
 * PropertySelectCell — the single-value selection control (owner 2026-10-09):
 * a full-width dropdown trigger whose content shows the selected value
 * compactly — a node renders as ONE pill (the shared NodePill element,
 * tinted with the effective color; never a subtree, never editable chrome),
 * a date renders its display name; an empty cell renders the muted "Select"
 * placeholder so the empty value still reads as a field spanning the value
 * cell. The owner popup (node picker / date picker) anchors at the trigger;
 * the clear affordance unsets the authored slot; trailing chrome (repeat
 * picker, link qualifiers, asset annotations) rides beside it. The trigger
 * is a div[role=button], not a native button: the content area hosts the
 * pill, which a <button> could not legally wrap.
 */
function PropertySelectCell({
  client,
  /** The selected node's id; null renders the placeholder. */
  valueRef,
  ariaLabel,
  placeholder = "Select",
  isOpen,
  /** The trigger hands its element to the parent (the popup anchors at it). */
  onToggle,
  clearLabel,
  onClear,
  /** Trailing chrome beside the trigger (repeat picker, qualifier range). */
  trailing,
  /** The selected value's content — one pill, or the date's display name. */
  children,
}: {
  client: AnyClient;
  valueRef: string | null;
  ariaLabel: string;
  placeholder?: string;
  isOpen: boolean;
  onToggle: (anchor: HTMLElement) => void;
  clearLabel: string;
  onClear: (() => void) | undefined;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const linkedNode = valueRef !== null ? client.getNode(valueRef) : undefined;
  const open = (anchor: HTMLElement) => onToggle(anchor);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(event.currentTarget);
    }
  };
  return (
    <div className="nt-property-select">
      <div
        role="button"
        tabIndex={0}
        className="nt-property-select__trigger"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onClick={(event) => open(event.currentTarget)}
        onKeyDown={onKeyDown}
      >
        <div className="nt-property-select__content">
          {valueRef === null ? (
            <span className="nt-property-select__placeholder">{placeholder}</span>
          ) : linkedNode === undefined ? (
            // PB1 honest broken reference: the raw id, never a silent void.
            <span
              className="nt-property-select__broken"
              title={`Broken reference: ${valueRef}`}
            >
              <code>{valueRef}</code>
            </span>
          ) : (
            children
          )}
        </div>
        <span className="nt-property-select__chevron" aria-hidden="true">
          <Icon path="mdi-chevron-down" size={0.7} />
        </span>
      </div>
      {onClear !== undefined && valueRef !== null && (
        <button
          type="button"
          className="nt-property-select__clear"
          aria-label={clearLabel}
          onClick={onClear}
        >
          ×
        </button>
      )}
      {trailing}
    </div>
  );
}

/**
 * One node-typed property: pills of the linked nodes + the add/upload picker.
 * `rows` are the effective rows of this schema on the node (authored pills
 * and, dimmed, any derived default) — empty when the binding has no values
 * yet, so the add affordance is reachable before the first link.
 */
function ObjectPropertyRow({
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
    return displayNameFromClient(client, ref) ?? ref;
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
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);

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
    isAssetTarget ? (
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
    const replaceIdx =
      singleRow !== undefined && singleRow.source === "authored" ? singleRow.idx : nextIdx;
    return (
      <li
        className={
          allDefault
            ? "nt-property nt-property-default nt-property-object node-metadata-row"
            : "nt-property nt-property-object node-metadata-row"
        }
      >
        {!bare && (
          <>
            <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
            {allDefault && <span className="nt-property-hint">default</span>}
            {unbound && <span className="nt-property-hint">unbound</span>}
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
            // ONE compact pill (owner 2026-10-09 follow-up): the dropdown's
            // content names the selected node and nothing more — never the
            // node's subtree, never editable row chrome.
            return (
              <NodePill
                color={client.effectiveNodeColor(linked)}
                icon={linked.icon}
                label={pillLabel(singleRef)}
              />
            );
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
                      presentAsMain: true,
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
          ? "nt-property nt-property-default nt-property-object node-metadata-row"
          : "nt-property nt-property-object node-metadata-row"
      }
    >
      {!bare && (
        <>
          <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
          {allDefault && <span className="nt-property-hint">default</span>}
          {unbound && <span className="nt-property-hint">unbound</span>}
        </>
      )}
      <span className="nt-property-chips node-metadata-pills">
        {pills.map(({ row, ref }) => {
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
          // values', owner follow-up 2026-10-09).
          return (
            <NodePill
              key={`${propertySchemaId}:${row.idx}`}
              color={client.effectiveNodeColor(linkedNode)}
              icon={linkedNode.icon}
              label={pillLabel(ref)}
              className={row.source === "default" ? "pill--default" : ""}
              hoverReveal={row.source !== "default"}
              onOpen={isAssetTarget ? download : () => onOpenPage?.(ref)}
              onRemove={row.source === "authored" ? () => void unlink(row.idx) : undefined}
              removeLabel={removeLabel}
              trailing={trailing}
            />
          );
        })}
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
                    presentAsMain: true,
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
function AssetPropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  multi,
  rows,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  rows: EffectiveProperty[];
  bare?: boolean;
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
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);

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
          <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
          {allDefault && <span className="nt-property-hint">default</span>}
          {unbound && <span className="nt-property-hint">unbound</span>}
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
                removable={row.source === "authored"}
                onRemove={() => void client.unsetProperty(nodeId, propertySchemaId, row.idx)}
              />
            ))}
          </ul>
        )}
        {(multi || items.length === 0) && (
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

/**
 * One linked asset in the asset property list: the thumbnail (image bytes
 * through the session cache; a kind icon otherwise) + the file name (the
 * node_asset original name — clicking downloads) + the remove button. A
 * value whose target is gone renders the broken-reference id honestly
 * (the dashed broken-mention policy), never a silent void.
 */
function AssetItemRow({
  client,
  assetRef,
  dimmed,
  removable,
  onRemove,
}: {
  client: AnyClient;
  assetRef: string;
  dimmed: boolean;
  removable: boolean;
  onRemove: () => void;
}) {
  const info = client.getAssetInfo(assetRef);
  const name = info?.originalName ?? displayNameFromClient(client, assetRef) ?? assetRef;
  const isImage = info !== undefined && info.mimeType.startsWith("image/");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    void assetImageUrl(client, assetRef).then((resolved) => {
      if (alive) setUrl(resolved);
    });
    return () => {
      alive = false;
    };
  }, [client, assetRef, isImage]);

  const linkedNode = client.getNode(assetRef);
  const broken = linkedNode === undefined;
  const download = () => {
    if (info !== undefined) void client.downloadAsset(info.assetId);
  };

  return (
    <li
      className={
        dimmed
          ? "nt-asset-item nt-asset-item--default"
          : broken
            ? "nt-asset-item nt-asset-item--broken"
            : "nt-asset-item"
      }
      title={broken ? `Broken reference: ${assetRef}` : undefined}
    >
      {broken ? (
        <span className="nt-asset-item__thumb nt-asset-item__thumb--broken" aria-hidden="true">
          <Icon path="mdi-file-question-outline" size={0.8} />
        </span>
      ) : isImage ? (
        url !== null ? (
          <img className="nt-asset-item__thumb" src={url} alt="" draggable="false" />
        ) : (
          <span className="nt-asset-item__thumb" aria-hidden="true">
            <Icon path="mdi-image-outline" size={0.8} />
          </span>
        )
      ) : (
        <span className="nt-asset-item__thumb" aria-hidden="true">
          <Icon
            path={
              info !== undefined && info.mimeType.startsWith("audio/")
                ? "mdi-music-note-outline"
                : "mdi-file-outline"
            }
            size={0.8}
          />
        </span>
      )}
      {broken ? (
        <span className="nt-asset-item__name nt-asset-item__name--broken">
          <code>{assetRef}</code>
        </span>
      ) : (
        <button
          type="button"
          className="nt-asset-item__name"
          title="Download"
          onClick={download}
        >
          {name}
        </button>
      )}
      {removable && !broken && (
        <button
          type="button"
          className="nt-asset-item__remove"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </li>
  );
}

/**
 * One date-typed property (SCHEMA.md "Dates"): the schema's effective rows
 * render as date pills; picking a date ensures the year/month/day chain and
 * links the node at the schema's precision ({ "nodeId": … }, the shape the
 * edge index projects — the year node backlinks everything dated that year).
 * Editing an existing pill's date overwrites the same slot's ref, preserving
 * the value's metadata (a re-pick keeps the recurrence rule; the
 * series follows the event). Each authored pill carries the repeat picker
 * (metadata.repeat, the startDate/endDate precedent).
 */
function DatePropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  multi,
  schema,
  rows,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  schema: { datePrecision?: DatePrecision | null } | null;
  rows: EffectiveProperty[];
  bare?: boolean;
}) {
  const [pickerFor, setPickerFor] = useState<number | "new" | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const precision = precisionOf(schema);
  const markedDates = collectMarkedDates(client);

  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const authoredIdx = ordered.filter((row) => row.source === "authored").map((row) => row.idx);
  const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;

  const commit = async (isoDate: string, idx: number): Promise<void> => {
    // Preserve the slot's metadata (the recurrence rule) across a re-pick.
    const metadata = ordered.find((row) => row.idx === idx)?.metadata ?? undefined;
    await client.setDateProperty(nodeId, propertySchemaId, isoDate, idx, metadata);
    setPickerFor(null);
  };

  /** The repeat write: merge/clear the `repeat` metadata key. */
  const setRepeat = async (row: EffectiveProperty, rule: string | null): Promise<void> => {
    const metadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
    if (rule === null) delete metadata.repeat;
    else metadata.repeat = rule;
    await client.setProperty(nodeId, propertySchemaId, row.value, row.idx, metadata);
  };

  const pillText = (row: EffectiveProperty): string => {
    const ref = nodeRefOf(row.value);
    if (ref !== null) return dateLabelOf(ref);
    return toEditableText(row.value); // scalar binding default, shown as-is
  };

  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);

  // Single-value: the selection dropdown (owner 2026-10-09) — empty renders
  // the "Select" placeholder across the full value cell; the committed date
  // rides the trigger content as the date node's DISPLAY name (a raw block
  // row would leak the chain's compact storage label, the YYYYMMDD leak
  // dateDisplay.ts exists to prevent). Re-picking overwrites the same slot.
  if (multi === false) {
    const single =
      [...ordered].reverse().find((row) => row.source === "authored") ?? ordered[0];
    const singleRef = single !== undefined ? nodeRefOf(single.value) : null;
    return (
      <li
        className={
          allDefault
            ? "nt-property nt-property-default nt-property-date node-metadata-row"
            : "nt-property nt-property-date node-metadata-row"
        }
      >
        {!bare && (
          <>
            <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
            {allDefault && <span className="nt-property-hint">default</span>}
            {unbound && <span className="nt-property-hint">unbound</span>}
          </>
        )}
        <PropertySelectCell
          client={client}
          valueRef={singleRef}
          ariaLabel={`Set ${label}`}
          isOpen={pickerFor !== null}
          onToggle={(anchor) => {
            anchorRef.current = anchor;
            setPickerFor((cur) =>
              cur === null ? (single !== undefined ? single.idx : "new") : null,
            );
          }}
          clearLabel={`Clear ${label}`}
          onClear={
            single !== undefined && single.source === "authored"
              ? () => void client.unsetProperty(nodeId, propertySchemaId, single.idx)
              : undefined
          }
          trailing={
            single !== undefined && single.source === "authored" && precision === "day" ? (
              <RepeatPicker
                value={typeof single.metadata?.repeat === "string" ? single.metadata.repeat : null}
                onChange={(rule) => void setRepeat(single, rule)}
                ariaLabel={`Repeat for ${label}`}
                iconOnly
              />
            ) : undefined
          }
        >
          {singleRef !== null
            ? (displayNameFromClient(client, singleRef) ?? dateLabelOf(singleRef))
            : null}
        </PropertySelectCell>
        {pickerFor !== null && (
          <DatePickerPopup
            value={
              pickerFor === "new"
                ? ""
                : (isoOfRef(nodeRefOf(ordered.find((row) => row.idx === pickerFor)?.value ?? null)) ?? "")
            }
            onSelect={(iso) => commit(iso, pickerFor === "new" ? nextIdx : pickerFor)}
            onClose={() => setPickerFor(null)}
            anchorRef={anchorRef}
            initialMode={precision === "year" ? "years" : precision === "month" ? "months" : "days"}
            firstDayOfWeek={1}
            markedDates={markedDates}
          />
        )}
      </li>
    );
  }

  return (
    <li
      className={
        allDefault
          ? "nt-property nt-property-default nt-property-date node-metadata-row"
          : "nt-property nt-property-date node-metadata-row"
      }
    >
      {!bare && (
        <>
          <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
          {allDefault && <span className="nt-property-hint">default</span>}
          {unbound && <span className="nt-property-hint">unbound</span>}
        </>
      )}
      <span className="nt-property-chips node-metadata-pills">
        {ordered.map((row) => (
          <span
            key={`${propertySchemaId}:${row.idx}`}
            className={
              row.source === "default"
                ? "pill pill--default"
                : "pill pill--hover-reveal-right"
            }
          >
            <button
              type="button"
              className="pill__text nt-chip-label"
              aria-label={`Set ${label}`}
              aria-expanded={pickerFor === row.idx}
              onClick={(event) => {
                anchorRef.current = event.currentTarget;
                setPickerFor((cur) => (cur === row.idx ? null : row.idx));
              }}
            >
              {pillText(row)}
            </button>
            {row.source === "authored" && (
              <button
                type="button"
                className="pill__right-button nt-chip-remove"
                aria-label={`Clear ${label}`}
                onClick={() => void client.unsetProperty(nodeId, propertySchemaId, row.idx)}
              >
                ×
              </button>
            )}
            {row.source === "authored" && precision === "day" && (
              <RepeatPicker
                value={
                  typeof row.metadata?.repeat === "string" ? row.metadata.repeat : null
                }
                onChange={(rule) => void setRepeat(row, rule)}
                ariaLabel={`Repeat for ${label}`}
                iconOnly
              />
            )}
          </span>
        ))}
        <AddPill
          label="Add"
          aria-expanded={pickerFor === "new"}
          onClick={(element) => {
            anchorRef.current = element;
            setPickerFor((cur) => (cur === "new" ? null : "new"));
          }}
        />
      </span>
      {pickerFor !== null && (
        <DatePickerPopup
          value={
            pickerFor === "new"
              ? ""
              : (isoOfRef(nodeRefOf(ordered.find((row) => row.idx === pickerFor)?.value ?? null)) ?? "")
          }
          onSelect={(iso) => commit(iso, pickerFor === "new" ? nextIdx : pickerFor)}
          onClose={() => setPickerFor(null)}
          anchorRef={anchorRef}
          initialMode={precision === "year" ? "years" : precision === "month" ? "months" : "days"}
          firstDayOfWeek={1}
          markedDates={markedDates}
        />
      )}
    </li>
  );
}

/** A date ref back to a full ISO date at its own precision (range merges). */
function isoOfRef(ref: string | null): string | null {
  if (ref === null) return null;
  const parsed = parseDateNodeId(ref);
  if (parsed === null) return null;
  const y = String(parsed.year).padStart(4, "0");
  const m = String(parsed.month).padStart(2, "0");
  const d = String(parsed.day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * One date_range property: start/end slots, each pickable and clearable —
 * either side open keeps an open range. Values are { start, end } of date
 * refs; precision applies to both ends (schema row).
 */
function DateRangePropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  multi,
  schema,
  rows,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  schema: { datePrecision?: DatePrecision | null } | null;
  rows: EffectiveProperty[];
  bare?: boolean;
}) {
  const [picking, setPicking] = useState<{ idx: number; end: "start" | "end" } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const precision = precisionOf(schema);
  const markedDates = collectMarkedDates(client);

  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const authoredIdx = ordered.filter((row) => row.source === "authored").map((row) => row.idx);
  const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;

  /** Override one end (null clears); the other end survives from the row. */
  const setEnd = async (idx: number, end: "start" | "end", iso: string | null): Promise<void> => {
    const current = rangeValueOf(ordered.find((row) => row.idx === idx)?.value);
    const start = end === "start" ? iso : isoOfRef(current.start);
    const stop = end === "end" ? iso : isoOfRef(current.end);
    await client.setDateRangeProperty(nodeId, propertySchemaId, start, stop, idx);
    setPicking(null);
  };

  const slot = (row: EffectiveProperty | undefined, idx: number, end: "start" | "end") => {
    const title = end === "start" ? "Start" : "End";
    const ref = rangeValueOf(row?.value)[end];
    return (
      <span className="nt-range-slot">
        <span className="nt-range-slot-name">{title}</span>
        <DateSlotControl
          client={client}
          value={isoOfRef(ref)}
          display={ref !== null ? dateLabelOf(ref) : "…"}
          ariaLabel={`Set ${title.toLowerCase()} for ${label}`}
          precision={precision}
          clearable={row?.source === "authored"}
          clearLabel={`Clear ${title.toLowerCase()} for ${label}`}
          onCommit={(iso) => void setEnd(idx, end, iso)}
        />
      </span>
    );
  };

  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);

  return (
    <li
      className={
        allDefault
          ? "nt-property nt-property-default nt-property-date-range node-metadata-row"
          : "nt-property nt-property-date-range node-metadata-row"
      }
    >
      {!bare && (
        <>
          <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
          {allDefault && <span className="nt-property-hint">default</span>}
          {unbound && <span className="nt-property-hint">unbound</span>}
        </>
      )}
      <span className="nt-property-chips node-metadata-pills">
        {ordered.map((row) => (
          <span key={`${propertySchemaId}:${row.idx}`} className="nt-range">
            {slot(row, row.idx, "start")}
            <span aria-hidden="true">→</span>
            {slot(row, row.idx, "end")}
            {row.source === "authored" && (
              <button
                type="button"
                className="nt-chip-remove"
                aria-label={`Clear ${label}`}
                onClick={() => void client.unsetProperty(nodeId, propertySchemaId, row.idx)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {!(multi === false && ordered.length > 0) && (
          <AddPill
            label="Add"
            aria-expanded={picking !== null && picking.idx === nextIdx}
            onClick={(element) => {
              anchorRef.current = element;
              setPicking((cur) =>
                cur !== null && cur.idx === nextIdx ? null : { idx: nextIdx, end: "start" },
              );
            }}
          />
        )}
      </span>
      {picking !== null && (
        <DatePickerPopup
          value={
            isoOfRef(
              rangeValueOf(ordered.find((r) => r.idx === picking.idx)?.value)[picking.end],
            ) ?? ""
          }
          onSelect={(iso) => void setEnd(picking.idx, picking.end, iso)}
          onClose={() => setPicking(null)}
          anchorRef={anchorRef}
          initialMode={precision === "year" ? "years" : precision === "month" ? "months" : "days"}
          firstDayOfWeek={1}
          markedDates={markedDates}
        />
      )}
    </li>
  );
}

/**
 * PC6 read-leniency: a qualifier slot reads BOTH shapes — a legacy ISO
 * string rides as-is; a canonical date-node ref formats from its
 * deterministic id (day precision `YYYY-MM-DD`). The panel still WRITES the
 * legacy string until the lockstep wave (the applier normalizes on write).
 */
function qualifierIsoOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "nodeId" in value) {
    const id = (value as { nodeId: unknown }).nodeId;
    if (typeof id === "string") {
      const parsed = parseDateNodeId(id);
      if (parsed !== null) {
        return `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
      }
      return id;
    }
  }
  return "";
}

/**
 * Link qualifier range control (SCHEMA.md "Dates", dateQualified schemas):
 * start/end date slots next to a node-typed pill; values persist as
 * property.set metadata.startDate/endDate (PC6 canonical: date-node refs —
 * the stored legacy ISO strings read back through qualifierIsoOf until the
 * lockstep wave switches the write path). The slots ride the shared
 * DateSlotControl — the same zoom-picker control the table
 * cells use, no native date inputs.
 */
function QualifierRange({
  client,
  start,
  end,
  ariaLabel,
  onCommit,
}: {
  client: AnyClient;
  start: string;
  end: string;
  ariaLabel: string;
  onCommit: (start: string, end: string) => void;
}) {
  return (
    <span className="nt-chip-qualifier">
      <DateSlotControl
        client={client}
        value={start === "" ? null : start}
        ariaLabel={`${ariaLabel} start date`}
        onCommit={(iso) => onCommit(iso ?? "", end)}
      />
      <span aria-hidden="true">–</span>
      <DateSlotControl
        client={client}
        value={end === "" ? null : end}
        ariaLabel={`${ariaLabel} end date`}
        onCommit={(iso) => onCommit(start, iso ?? "")}
      />
    </span>
  );
}

/**
 * One select-typed property: the ported options control renders the selected
 * option pills (+ picker) for schemas that declare options; the value ids
 * reference the schema option ids.
 */
function SelectPropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  multi,
  options,
  rows,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  options: SelectionOption[];
  rows: EffectiveProperty[];
  bare?: boolean;
}) {
  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);

  const valuesOf = (row: EffectiveProperty): string[] =>
    Array.isArray(row.value)
      ? row.value.filter((v): v is string => typeof v === "string")
      : typeof row.value === "string" && row.value !== ""
        ? [row.value]
        : [];

  const write = async (idx: number, value: unknown): Promise<void> => {
    await client.setProperty(nodeId, propertySchemaId, value, idx);
  };

  const remove = async (row: EffectiveProperty, optionId: string): Promise<void> => {
    const values = valuesOf(row).filter((id) => id !== optionId);
    if (multi && values.length > 0) {
      await write(row.idx, values);
    } else {
      await client.unsetProperty(nodeId, propertySchemaId, row.idx);
    }
  };

  return (
    <>
      {ordered.map((row) => (
        <li
          key={`${propertySchemaId}:${row.idx}`}
          className={
            allDefault
              ? "nt-property nt-property-default nt-property-select node-metadata-row"
              : "nt-property nt-property-select node-metadata-row"
          }
        >
          {!bare && (
            <>
              <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
              {allDefault && <span className="nt-property-hint">default</span>}
              {unbound && <span className="nt-property-hint">unbound</span>}
            </>
          )}
          <SelectionPropertyControl
            options={options}
            values={valuesOf(row)}
            multi={multi}
            onAdd={(optionId) => {
              const values = valuesOf(row);
              void write(
                row.idx,
                multi ? [...values.filter((id) => id !== optionId), optionId] : optionId,
              );
            }}
            onRemove={(optionId) => void remove(row, optionId)}
          />
        </li>
      ))}
      {ordered.length === 0 && (
        <li className="nt-property nt-property-select node-metadata-row">
          {!bare && (
            <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
          )}
          <SelectionPropertyControl
            options={options}
            values={[]}
            multi={multi}
            onAdd={(optionId) => void write(nextIdxOf([]), multi ? [optionId] : optionId)}
            onRemove={() => undefined}
          />
        </li>
      )}
    </>
  );
}

/** Next free idx for a schema with no effective rows yet. */
function nextIdxOf(rows: EffectiveProperty[]): number {
  const authoredIdx = rows.filter((row) => row.source === "authored").map((row) => row.idx);
  return authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;
}

/**
 * One boolean property: the ported checkbox toggle writes the slot directly.
 */
function BooleanPropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  rows,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  rows: EffectiveProperty[];
  bare?: boolean;
}) {
  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);

  return (
    <>
      {ordered.map((row) => (
        <li
          key={`${propertySchemaId}:${row.idx}`}
          className={
            allDefault
              ? "nt-property nt-property-default nt-property-boolean node-metadata-row"
              : "nt-property nt-property-boolean node-metadata-row"
          }
        >
          {!bare && (
            <>
              <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
              {allDefault && <span className="nt-property-hint">default</span>}
              {unbound && <span className="nt-property-hint">unbound</span>}
            </>
          )}
          <Checkbox
            size="sm"
            checked={row.value === true}
            disabled={row.readonly === true}
            aria-label={`Property ${label}`}
            onChange={(event) => {
              void client.setProperty(nodeId, propertySchemaId, event.target.checked, row.idx);
            }}
          />
        </li>
      ))}
      {ordered.length === 0 && (
        <li className="nt-property nt-property-boolean node-metadata-row">
          {!bare && (
            <span className="section-label nt-property-name" data-property-schema-id={propertySchemaId}>{label}</span>
          )}
          <Checkbox
            size="sm"
            checked={false}
            aria-label={`Property ${label}`}
            onChange={(event) => {
              void client.setProperty(nodeId, propertySchemaId, event.target.checked, 0);
            }}
          />
        </li>
      )}
    </>
  );
}

/**
 * The node's own classes: pills with an × that unassigns (class.unassign),
 * a right-click color-swatch menu (object.update color), and a "+ Add class"
 * ghost pill opening the node-selector popup (assignClass): the pills
 * ride ClassPillsList — the instance-of relation's mutations passed as
 * arguments, the row chrome (the label) stays here.
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
  return (
    <div className="node-metadata-row nt-classes-row">
      <div className="section-label">Classes:</div>
      <ClassPillsList
        client={client}
        nodeId={nodeId}
        query={classIds}
        add={(classId) => void client.assignClass(nodeId, classId)}
        remove={(classId) => void client.unassignClass(nodeId, classId)}
        reorder={(ordered) => void client.reorderClasses(nodeId, ordered)}
        onOpenPage={onOpenPage}
      />
    </div>
  );
}

/**
 * TagsRow — the "Tags:" metadata row (pages and blocks): any page can be
 * assigned as a tag. Pills mirror the classes row; right-click opens the
 * node menu (remove goes through unassignTag).
 */
export function TagsRow({
  client,
  nodeId,
  tagIds,
  onOpenPage,
}: {
  client: AnyClient;
  nodeId: string;
  tagIds: string[];
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nodeMenu, setNodeMenu] = useState<{ node: ClientNode; x: number; y: number } | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  // Tags render alphabetically everywhere (owner rule): order by display name.
  const assignedTags = [...tagIds]
    .sort((a, b) =>
      (displayNameFromClient(client, a) ?? a).localeCompare(
        displayNameFromClient(client, b) ?? b,
      ),
    )
    .map((tagId) => client.getNode(tagId))
    .filter((node): node is ClientNode => node !== undefined);

  return (
    <div className="node-metadata-row nt-tags-row">
      <div className="section-label">Tags:</div>
      <div className="nt-property-chips node-metadata-pills">
        {assignedTags.map((tag) => {
          const label = displayNameFromClient(client, tag.id) ?? tag.id;
          // Pill chrome like classes: grey surface by default, the tag's
          // effectiveColor (own, else its classes') as the background when set.
          const colored = client.effectiveNodeColor(tag);
          return (
            <span
              key={tag.id}
              className="pill pill--hover-reveal-right"
              style={
                colored !== null
                  ? { background: cssColorFor(colored), color: contrastFor(colored) }
                  : undefined
              }
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setNodeMenu({ node: tag, x: event.clientX, y: event.clientY });
              }}
            >
              {tag.icon !== null && (
                <span className="pill__left-icon">
                  <Icon path={tag.icon} size={0.7} />
                </span>
              )}
              <button
                type="button"
                className="pill__text"
                onClick={() => onOpenPage?.(tag.id)}
              >
                {label}
              </button>
              <button
                type="button"
                className="pill__right-button"
                aria-label={`Remove tag ${label}`}
                onClick={() => void client.unassignTag(nodeId, tag.id)}
              >
                ×
              </button>
            </span>
          );
        })}
        <span className="nt-class-add-anchor">
          <AddPill
            ref={addButtonRef}
            className={tagIds.length > 0 ? "pill--icon-only" : ""}
            label="Add tag"
            aria-expanded={pickerOpen}
            onClick={(element) => {
              addButtonRef.current = element;
              setPickerOpen(true);
            }}
          />
        </span>
      </div>
      {pickerOpen && (
        <NodeSelector
          client={client}
          anchorEl={addButtonRef.current}
          searchMode="pages"
          nodes={assignedTags}
          excludeNodeId={nodeId}
          alwaysShowCreate
          searchPlaceholder="Search pages…"
          onClose={() => setPickerOpen(false)}
          onAdd={(node) => {
            setPickerOpen(false);
            void client.assignTag(nodeId, node.id);
          }}
        />
      )}
      <NodeContextMenu
        state={nodeMenu === null ? null : { ...nodeMenu, ownerId: nodeId, isPage: true }}
        client={client}
        onClose={() => setNodeMenu(null)}
        onOpenNode={(id) => onOpenPage?.(id)}
        onRemoveFromOwner={() => {
          if (nodeMenu !== null) void client.unassignTag(nodeId, nodeMenu.node.id);
        }}
      />
    </div>
  );
}

/**
 * AliasesRow — the "Aliases:" row at the TOP of the metadata panel (owner
 * 2026-10-09; relocated from the title-row AliasesButton): every live page
 * whose alias-terminal is this node (chains included, via the client's
 * aliasNodesOf read over the `aliased_node_id` column), as a node list —
 * one pill per alias, a "+ Add alias" ghost pill, an × per entry that clears
 * THE ALIAS's own field (the relation's mutations, like ClassesRow).
 *
 * The pills ride the shared NodePill element + AddPill + NodeSelector (the
 * TagsRow composition — NodePills itself stays class-scoped: its picker,
 * color-chain resolution, and removal locks are class semantics). ADD writes
 * THE SELECTED node's `aliasedNodeId` to the ACTIVE node — the backward
 * write, never the active node's own field (the main page holds nothing) —
 * with the page-restriction guard validating the pick (the picker filters
 * out already-aliased nodes and the active node itself). Opening a pill
 * rides the RAW bypass (the retired popup's NAVIGATE contract): the alias's
 * OWN view, from where the "Alias of …" banner jumps back — the resolving
 * open would land on the page already on screen.
 *
 * Pages only: the write guard makes a non-page target unwritable, so a block
 * (BlockRow hosts the same section) renders no row.
 */
export function AliasesRow({
  client,
  nodeId,
  onOpenPage,
  onOpenPageRaw = undefined,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** The RAW open — bypasses the alias redirect so the alias's OWN view renders. */
  onOpenPageRaw?: ((pageId: string) => void) | undefined;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  // Freshness: the cached aliasNodesOf read converges via the client's
  // change notification — bump a version so the row follows writes (the
  // panel hosts no subscription of its own).
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const node = client.getNode(nodeId);
  if (node === undefined || !rendersWithDocumentChrome(node)) return null;

  const aliases = client.aliasNodesOf(nodeId);

  return (
    <div className="node-metadata-row nt-aliases-row">
      <div className="section-label">Aliases:</div>
      <span className="nt-property-chips node-metadata-pills">
        {aliases.map((alias) => {
          const label = displayNameFromClient(client, alias.id) ?? alias.id;
          return (
            <NodePill
              key={alias.id}
              color={client.effectiveNodeColor(alias)}
              icon={alias.icon}
              label={label}
              onOpen={() => (onOpenPageRaw ?? onOpenPage)?.(alias.id)}
              onRemove={() => void client.updateObject(alias.id, { aliasedNodeId: null })}
              removeLabel={`Remove alias ${label}`}
            />
          );
        })}
        <span className="nt-class-add-anchor">
          <AddPill
            ref={addButtonRef}
            className={aliases.length > 0 ? "pill--icon-only" : ""}
            label="Add alias"
            aria-expanded={pickerOpen}
            onClick={(element) => {
              addButtonRef.current = element;
              setPickerOpen(true);
            }}
          />
        </span>
      </span>
      {pickerOpen && (
        <AliasNodePicker
          client={client}
          nodeId={nodeId}
          anchorEl={addButtonRef.current}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}


/** "+ Add property": pick an existing schema (or create one) and realize an
 *  initial value on the node so the row appears. */
function AddPropertyRow({
  client,
  nodeId,
}: {
  client: AnyClient;
  nodeId: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const schemas = client.listPropertySchemas();

  async function initializeValue(schemaId: string, type: string): Promise<void> {
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
      case "date": {
        // Local midnight, not UTC — the "today" default must match the
        // user's calendar day.
        const dayId = await client.ensureDateChain(todayIsoLocal());
        await client.setProperty(nodeId, schemaId, { nodeId: dayId }, 0);
        return;
      }
      default:
        // url/email/select/multi_select/object/image: no sensible empty
        // value — the row's own editor will prompt on first edit.
        return;
    }
  }

  async function pickSchema(schemaId: string, type: string): Promise<void> {
    setError(null);
    try {
      await initializeValue(schemaId, type);
      setPickerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createSchema(): Promise<void> {
    const name = newName.trim();
    if (name === "") return;
    setError(null);
    try {
      const schemaId = await client.createPropertySchema({ name, type: "text" });
      await initializeValue(schemaId, "text");
      setCreating(false);
      setNewName("");
      setPickerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="nt-add-property">
      <AddPill
        ref={buttonRef}
        label="Add property"
        aria-expanded={pickerOpen}
        onClick={(element) => {
          buttonRef.current = element;
          setPickerOpen((open) => !open);
          setCreating(false);
        }}
      />
      {pickerOpen && (
        <div className="nt-add-property-popup" role="dialog" aria-label="Add property">
          <input
            autoFocus
            placeholder="Search or create property…"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <ul>
            {schemas
              .filter((schema) => newName.trim() === "" || schema.name.toLowerCase().includes(newName.trim().toLowerCase()))
              .map((schema) => (
                <li key={schema.id}>
                  <button type="button" onClick={() => void pickSchema(schema.id, schema.type)}>
                    <span className="nt-add-property-name">{schema.name}</span>
                    <span className="nt-add-property-type">{schema.type}</span>
                  </button>
                </li>
              ))}
          </ul>
          {newName.trim() !== "" && !schemas.some((s) => s.name.toLowerCase() === newName.trim().toLowerCase()) && (
            <button type="button" className="nt-add-property-create" onClick={() => void createSchema()}>
              Create property "{newName.trim()}"
            </button>
          )}
          {error !== null && <p className="nt-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The property-rows model shared by the Metadata section (blocks) and the
 * Properties section (pages): effective rows grouped per schema, plus the
 * bound-but-empty grouped bindings that still render an add affordance.
 *
 * `omitDisplayPositions` filters out rows whose SCHEMA carries a
 * bullet/inline value-display position (the render contracts are
 * property-level; the block row surfaces those values itself — the panel
 * must not duplicate them). The same filter applies to the bound-but-empty
 * bindings, whose add affordance the block row's icon button already covers.
 */
function propertyGroupsOf(
  client: AnyClient,
  nodeId: string,
  omitDisplayPositions?: ReadonlyArray<"bullet" | "inline">,
) {
  const omittedByDisplay = (display: PropertyDisplay | null): boolean =>
    (display === "bullet" || display === "inline") &&
    (omitDisplayPositions?.includes(display) ?? false);
  const node = client.getNode(nodeId);
  // Class pages: the class's has-template values render in the dedicated
  // Templates section — the generic table suppresses that schema row. The
  // cover schema is suppressed EVERYWHERE: the cover is header
  // chrome (PageBanner/AddCover), never a property row.
  const isClassNode = node?.isClass === true;
  const rows = client
    .getEffectiveProperties(nodeId)
    .filter(
      (row) =>
        !(isClassNode && row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.hasTemplate) &&
        row.propertySchemaId !== SYSTEM_PROPERTY_UUIDS.cover &&
        !omittedByDisplay(row.display),
    );

  // Node-typed / date / date_range / boolean / text schemas render as one
  // grouped row per schema; the `asset` type joins the family with its
  // dedicated row (the upload/link chrome + the multi asset list).
  // Select AND multi_select schemas join them only when they declare
  // options (without options the minimal text editor is the honest editor —
  // there is nothing to pick; the shape routes multi_select to the selection
  // control). Text groups render as a blocks list (the carrier blocks
  // themselves). Grouped rows appear at their first occurrence so the panel
  // order is unchanged.
  const optionsOf = (propertySchemaId: string) =>
    client.listPropertySchemas().find((s) => s.id === propertySchemaId)?.options;
  const isGroupedType = (type: string | undefined, propertySchemaId: string): boolean => {
    if (type === "object" || type === "asset" || type === "date" || type === "date_range" || type === "boolean" || type === "text") {
      return true;
    }
    if (type === "select" || type === "multi_select") {
      const options = optionsOf(propertySchemaId);
      return options !== null && options !== undefined && options.length > 0;
    }
    return false;
  };

  const renderedGroups = new Set<string>();
  const rendered = rows.map((row) => {
    const type = row.schema?.type;
    if (!isGroupedType(type, row.propertySchemaId)) {
      return { kind: "scalar" as const, row };
    }
    if (renderedGroups.has(row.propertySchemaId)) return null;
    renderedGroups.add(row.propertySchemaId);
    return {
      kind: "grouped" as const,
      propertySchemaId: row.propertySchemaId,
      type,
      groupRows: rows.filter((r) => r.propertySchemaId === row.propertySchemaId),
    };
  });

  // A bound grouped property with no effective rows still renders: the row
  // hosts the add/set affordance (the scalar editor has no way to author a
  // first value). hide-when-empty schemas are the exception: the
  // render contracts are property-level — read from the schema row, not the
  // binding).
  const emptyObjectBindings: ClassBinding[] = [];
  for (const classId of node?.classIds ?? []) {
    for (const binding of client.getClassBindings(classId)) {
      if (!isGroupedType(binding.type, binding.propertySchemaId)) continue;
      if (isClassNode && binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.hasTemplate) continue;
      if (binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover) continue;
      const schemaRow = client.listPropertySchemas().find((s) => s.id === binding.propertySchemaId);
      if (omittedByDisplay(schemaRow?.display ?? null)) continue;
      if (renderedGroups.has(binding.propertySchemaId)) continue;
      if (emptyObjectBindings.some((b) => b.propertySchemaId === binding.propertySchemaId)) continue;
      if (schemaRow?.hideWhenEmpty === true) continue;
      emptyObjectBindings.push(binding);
    }
  }

  return { rows, rendered, emptyObjectBindings };
}

type PropertyGroups = ReturnType<typeof propertyGroupsOf>;

/** Visible table rows: scalars + one per grouped schema + empty bindings. */
function propertiesCountOf(groups: PropertyGroups): number {
  return groups.rendered.filter((entry) => entry !== null).length + groups.emptyObjectBindings.length;
}

/**
 * PropertiesTable — the property rows and the add affordance, shared by the
 * Metadata section (blocks) and the Properties section (pages).
 *
 * Property interactions: clicking a property LABEL opens the
 * property's configuration (PropertySettingsModal); right-clicking it opens
 * the context menu (Open property / Empty property / Remove from node).
 * Both ride event delegation on the list — the label spans carry
 * `data-property-schema-id`.
 */
/**
 * GroupedPropertyRow — one row per grouped schema (node-typed / date /
 * date_range / boolean / text always; select schemas once they declare
 * options), the per-type value-row component chosen by schema type.
 * Shared by the properties table and the properties sidebar.
 */
function GroupedPropertyRow({
  client,
  nodeId,
  type,
  propertySchemaId,
  label,
  multi,
  schema,
  bindingFilter,
  groupRows,
  onOpenPage,
  /** Hide the label/hints (the host chrome carries them — the sidebar). */
  bare = false,
}: {
  client: AnyClient;
  nodeId: string;
  type: string | undefined;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  schema: { datePrecision?: DatePrecision | null } | null;
  bindingFilter: string[] | null;
  groupRows: EffectiveProperty[];
  onOpenPage?: ((pageId: string) => void) | undefined;
  bare?: boolean;
}) {
  if (type === "date") {
    return (
      <DatePropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        schema={schema}
        rows={groupRows}
        bare={bare}
      />
    );
  }
  if (type === "date_range") {
    return (
      <DateRangePropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        schema={schema}
        rows={groupRows}
        bare={bare}
      />
    );
  }
  if (type === "select" || type === "multi_select") {
    const options =
      client.listPropertySchemas().find((s) => s.id === propertySchemaId)?.options ?? [];
    return (
      <SelectPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={type === "multi_select" ? true : multi}
        options={options}
        rows={groupRows}
        bare={bare}
      />
    );
  }
  if (type === "boolean") {
    return (
      <BooleanPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        rows={groupRows}
        bare={bare}
      />
    );
  }
  if (type === "text") {
    return (
      <TextPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        rows={groupRows}
        onOpenPage={onOpenPage}
        bare={bare}
      />
    );
  }
  if (type === "asset") {
    return (
      <AssetPropertyRow
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        rows={groupRows}
        bare={bare}
      />
    );
  }
  return (
    <ObjectPropertyRow
      client={client}
      nodeId={nodeId}
      propertySchemaId={propertySchemaId}
      label={label}
      multi={multi}
      bindingFilter={bindingFilter}
      rows={groupRows}
      onOpenPage={onOpenPage}
      bare={bare}
    />
  );
}

/**
 * ScalarPropertyValue — the value cell of a scalar (ungrouped) property
 * row: a node-backed carrier block renders its editable subtree; anything
 * else rides the minimal text editor (a dead carrier reference renders
 * EMPTY, never the raw uuid — typing authors a fresh carrier, leaving it
 * empty unsets the dead value). Shared by the properties table and the
 * sidebar; the row chrome (label, hints, li wrapper) stays at the call
 * sites.
 */
function ScalarPropertyValue({
  client,
  nodeId,
  row,
  onOpenPage,
}: {
  client: AnyClient;
  nodeId: string;
  row: EffectiveProperty;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  // Text properties are node-backed: the value references a carrier
  // block — {"nodeId"} after migration, a bare uuid string in archived
  // data. Render the block, editable, in place of the raw input when it
  // resolves to a block.
  const editable = toEditableText(row.value);
  const rawRef =
    typeof row.value === "object" && row.value !== null && "nodeId" in (row.value as object)
      ? String((row.value as { nodeId: unknown }).nodeId)
      : typeof editable === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(editable)
        ? editable
        : null;
  const rawNode = rawRef !== null ? client.getNode(rawRef) : undefined;
  const carrier =
    rawNode !== undefined && rendersAsInlineBlock(rawNode) ? rawNode : undefined;
  // Dead carrier (owner bug report 2026-10-04): the value references a
  // carrier block that was deleted/trashed from the value cell. The
  // content is GONE — display EMPTY, never the raw uuid; editing authors
  // a fresh carrier, and touching it empty cleans the dead value row (so
  // the uuid does not survive reloads).
  const deadCarrierRef = rawRef !== null && carrier === undefined;
  const editableText = deadCarrierRef ? "" : toEditableText(row.value);
  // Url/email scalars keep the text editor and gain an
  // external-link affordance (mailto: for email; url values keep their
  // authored scheme, tel: included).
  const linkHref = propertyLinkHref(row.schema?.type, row.value);
  return (
    <>
      {carrier !== undefined ? (
        <span className="nt-property-blockcell">
          <ReferenceSubtree client={client} rootId={carrier.id} onOpenNode={onOpenPage} />
        </span>
      ) : (
        <input
          key={`${row.propertySchemaId}:${row.idx}:${editableText}`}
          type="text"
          className="nt-property-value"
          defaultValue={editableText}
          aria-label={`Property ${row.schema?.name ?? row.propertySchemaId}`}
          onBlur={(event) => {
            const text = event.target.value;
            if (deadCarrierRef) {
              // The old carrier is gone: typing authors a NEW carrier
              // (the established create-carrier pattern); leaving it empty unsets the dead
              // value so the row does not hold a dangling ref.
              if (text.trim() === "") {
                void client.unsetProperty(nodeId, row.propertySchemaId, row.idx);
              } else {
                void (async () => {
                  const carrierId = await client.createObject({
                    parentId: nodeId,
                    contentAst: [{ type: "text", text }],
                  });
                  await client.setProperty(
                    nodeId,
                    row.propertySchemaId,
                    { nodeId: carrierId },
                    row.idx,
                  );
                })();
              }
              return;
            }
            const next = fromEditableText(text);
            // Deep-compare so a no-op blur never enqueues a write.
            if (JSON.stringify(next) !== JSON.stringify(row.value)) {
              void client.setProperty(nodeId, row.propertySchemaId, next, row.idx);
            }
          }}
        />
      )}
      {linkHref !== null && (
        <a
          className="nt-property-link"
          href={linkHref}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${row.schema?.name ?? row.propertySchemaId}`}
        >
          <Icon path="mdi-open-in-new" size={0.7} />
        </a>
      )}
    </>
  );
}

export function PropertiesTable({
  client,
  nodeId,
  onOpenPage,
  omitDisplayPositions,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** Schema display positions (bullet/inline) the host surfaces
   *  itself — filter out. */
  omitDisplayPositions?: ReadonlyArray<"bullet" | "inline"> | undefined;
}) {
  const { rows, rendered, emptyObjectBindings } = propertyGroupsOf(client, nodeId, omitDisplayPositions);
  const labelOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [viewFor, setViewFor] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ schemaId: string; x: number; y: number } | null>(null);

  const schemaIdFromEvent = (event: React.SyntheticEvent): string | null => {
    const target = event.target as HTMLElement;
    const label = target.closest<HTMLElement>("[data-property-schema-id]");
    return label?.dataset.propertySchemaId ?? null;
  };

  const isBound = (schemaId: string): boolean => {
    const node = client.getNode(nodeId);
    for (const classId of node?.classIds ?? []) {
      if (client.getClassBindings(classId).some((b) => b.propertySchemaId === schemaId)) return true;
    }
    return false;
  };
  const isReadonly = (schemaId: string): boolean =>
    rows.some((r) => r.propertySchemaId === schemaId && r.readonly === true);
  const emptyProperty = (schemaId: string) => {
    for (const row of rows) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.setProperty(nodeId, schemaId, "", row.idx);
      }
    }
  };
  const removeFromNode = (schemaId: string) => {
    for (const row of rows) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.unsetProperty(nodeId, schemaId, row.idx);
      }
    }
  };

  const menuItems = (schemaId: string) => {
    const bound = isBound(schemaId);
    const readonly = isReadonly(schemaId);
    return [
      { id: "open", label: "Open property", icon: "mdi-open-in-app", onClick: () => setSettingsFor(schemaId) },
      {
        id: "history",
        label: "Value history…",
        icon: "mdi-history",
        onClick: () => setHistoryFor(schemaId),
      },
      {
        id: "empty",
        label: "Empty property",
        icon: "mdi-eraser",
        disabled: readonly,
        onClick: () => emptyProperty(schemaId),
      },
      {
        id: "remove",
        label: "Remove from node",
        icon: "mdi-close-circle-outline",
        danger: true,
        disabled: bound || readonly,
        onClick: () => removeFromNode(schemaId),
      },
    ];
  };


  const groupedRow = (
    type: string | undefined,
    propertySchemaId: string,
    label: string,
    multi: boolean,
    schema: { datePrecision?: DatePrecision | null } | null,
    bindingFilter: string[] | null,
    groupRows: EffectiveProperty[],
  ) => (
    <GroupedPropertyRow
      key={propertySchemaId}
      client={client}
      nodeId={nodeId}
      type={type}
      propertySchemaId={propertySchemaId}
      label={label}
      multi={multi}
      schema={schema}
      bindingFilter={bindingFilter}
      groupRows={groupRows}
      onOpenPage={onOpenPage}
    />
  );

  return (
    <>
      <ul
        className="nt-properties-list"
        onClick={(event) => {
          const schemaId = schemaIdFromEvent(event);
          if (schemaId !== null) setSettingsFor(schemaId);
        }}
        onContextMenu={(event) => {
          const schemaId = schemaIdFromEvent(event);
          if (schemaId === null) return;
          event.preventDefault();
          event.stopPropagation();
          setMenu({ schemaId, x: event.clientX, y: event.clientY });
        }}
      >
          {/* The alias-side pseudo-property: chrome over the `aliasedNodeId`
              node field itself (null for every ordinary node). */}
          <AliasedNodeRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} />
          {rendered.map((entry) => {
            if (entry === null) return null;
            if (entry.kind === "grouped") {
              const schema = entry.groupRows[0]?.schema ?? null;
              return groupedRow(
                entry.type,
                entry.propertySchemaId,
                schema?.name ?? entry.propertySchemaId,
                schema?.multi ?? true,
                schema,
                null,
                entry.groupRows,
              );
            }
            const row = entry.row;
            const label = labelOf(row);
            return (
              <li
                key={`${row.propertySchemaId}:${row.idx}`}
                className={
                  row.source === "default"
                    ? "nt-property nt-property-default node-metadata-row"
                    : "nt-property node-metadata-row"
                }
              >
                <span className="section-label nt-property-name" data-property-schema-id={row.propertySchemaId}>{label}</span>
                {row.source === "default" && <span className="nt-property-hint">default</span>}
                {row.source === "authored" && row.boundBy === null && (
                  <span className="nt-property-hint">unbound</span>
                )}
                <ScalarPropertyValue client={client} nodeId={nodeId} row={row} onOpenPage={onOpenPage} />
              </li>
            );
          })}
          {emptyObjectBindings.map((binding) =>
            groupedRow(
              binding.type,
              binding.propertySchemaId,
              binding.name,
              binding.multi,
              { datePrecision: binding.datePrecision },
              binding.targetClassFilter,
              [],
            ),
          )}
      </ul>
      <AddPropertyRow client={client} nodeId={nodeId} />
      {menu !== null && (
        <ContextMenu items={menuItems(menu.schemaId)} position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />
      )}
      {settingsFor !== null && (
        <PropertySettingsModal
          client={client}
          propertySchemaId={settingsFor}
          onClose={() => setSettingsFor(null)}
          onOpenView={() => {
            setViewFor(settingsFor);
            setSettingsFor(null);
          }}
        />
      )}
      {viewFor !== null && (
        <PropertyView
          client={client}
          propertySchemaId={viewFor}
          onClose={() => setViewFor(null)}
          onOpenPage={(id) => {
            setViewFor(null);
            onOpenPage?.(id);
          }}
        />
      )}
      {historyFor !== null && (
        <PropertyHistoryModal
          client={client}
          nodeId={nodeId}
          propertySchemaId={historyFor}
          schemaName={
            client.listPropertySchemas().find((s) => s.id === historyFor)?.name ?? historyFor
          }
          onClose={() => setHistoryFor(null)}
        />
      )}
    </>
  );
}

/**
 * PropertiesSection — the page's "Metadata N" section (note layout; owner
 * 2026-10-09: the properties panel is named Metadata, and the aliases row —
 * relocated from the title-row button — rides its top as the first
 * section): every property field in the table, collapsed by default.
 * Classes and tags are identity rows in the page header, not properties —
 * the count covers property rows only.
 */
export function PropertiesSection({
  client,
  nodeId,
  onOpenPage,
  onOpenPageRaw = undefined,
  hideWhenEmpty = false,
  omitDisplayPositions,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** The RAW open for the aliases row's pill (bypasses the alias redirect). */
  onOpenPageRaw?: ((pageId: string) => void) | undefined;
  /** Block mode: render nothing when the node carries no properties. */
  hideWhenEmpty?: boolean | undefined;
  /** Schema display positions the host renders itself (the block
   *  row's bullet/inline icon buttons) — rows carrying them are filtered
   *  out of this panel so the value never reads twice. */
  omitDisplayPositions?: ReadonlyArray<"bullet" | "inline"> | undefined;
}) {
  const count = propertiesCountOf(propertyGroupsOf(client, nodeId, omitDisplayPositions));
  if (hideWhenEmpty && count === 0) return null;
  return (
    <NodeViewSection
      title="Metadata"
      icon={<Icon path="mdi-format-list-bulleted-square" size={0.9} />}
      count={count}
      className="node-metadata-section nt-properties-panel"
      defaultExpanded={false}
    >
      <div className="node-metadata-content">
        {/* The aliases list is the panel's first section — pages only (the
            row renders null for blocks, so BlockRow's hideWhenEmpty usage
            gains no empty chrome). */}
        <AliasesRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} onOpenPageRaw={onOpenPageRaw} />
        <PropertiesTable
          client={client}
          nodeId={nodeId}
          onOpenPage={onOpenPage}
          omitDisplayPositions={omitDisplayPositions}
        />
      </div>
    </NodeViewSection>
  );
}

/**
 * PropertiesSidebar — the main layout's first column (owner 2026-10-06;
 * renamed "Metadata" + the aliases row on top, owner 2026-10-09):
 * a set of rows, one per property — a property-name row followed by its
 * value-cell row — beside a continuous vertical divider (the sidebar's
 * right edge runs the card's full height, no top or bottom gap). The rows
 * ride a collapsible NodeViewSection (owner 2026-10-09, expanded by
 * default): the section header names the column — dotted-list icon +
 * "Metadata" + the effective row count — and collapsing keeps the
 * column's divider while the rows step aside. The panel's FIRST section is
 * the aliases row (relocated from the title-row button): every alias of the
 * page as pills with an × each, "+ Add alias" riding the pages-only picker
 * (the backward write, exactly like the retired popup). The value cells
 * reuse the properties table's row components verbatim (only their internal
 * label/hints hide — the name row above carries them); only the two-row
 * stacking and the divider are this component's own. Clicking a name row
 * opens the property's settings, like the table's label click.
 */
export function PropertiesSidebar({
  client,
  nodeId,
  onOpenPage,
  onOpenPageRaw = undefined,
}: {
  client: AnyClient;
  nodeId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
  /** The RAW open for the aliases row's pill (bypasses the alias redirect). */
  onOpenPageRaw?: ((pageId: string) => void) | undefined;
}) {
  const groups = propertyGroupsOf(client, nodeId);
  const { rendered, emptyObjectBindings } = groups;
  const count = propertiesCountOf(groups);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [viewFor, setViewFor] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ schemaId: string; x: number; y: number } | null>(null);
  const labelOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;

  const hintOf = (rows: EffectiveProperty[]): string | null => {
    if (rows.length === 0) return null;
    if (rows.every((row) => row.source === "default")) return "default";
    if (rows.some((row) => row.source === "authored" && row.boundBy === null)) return "unbound";
    return null;
  };

  // The name row's right-click menu rides the same actions as the table's
  // label (Open property / Value history / Empty / Remove).
  const rowsOf = rendered.flatMap((entry) =>
    entry === null ? [] : entry.kind === "grouped" ? entry.groupRows : [entry.row],
  );
  const isBound = (schemaId: string): boolean => {
    const node = client.getNode(nodeId);
    for (const classId of node?.classIds ?? []) {
      if (client.getClassBindings(classId).some((b) => b.propertySchemaId === schemaId)) return true;
    }
    return false;
  };
  const isReadonly = (schemaId: string): boolean =>
    rowsOf.some((r) => r.propertySchemaId === schemaId && r.readonly === true);
  const emptyProperty = (schemaId: string) => {
    for (const row of rowsOf) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.setProperty(nodeId, schemaId, "", row.idx);
      }
    }
  };
  const removeFromNode = (schemaId: string) => {
    for (const row of rowsOf) {
      if (row.propertySchemaId === schemaId && row.source === "authored") {
        void client.unsetProperty(nodeId, schemaId, row.idx);
      }
    }
  };
  const menuItems = (schemaId: string) => {
    const bound = isBound(schemaId);
    const readonly = isReadonly(schemaId);
    return [
      { id: "open", label: "Open property", icon: "mdi-open-in-app", onClick: () => setSettingsFor(schemaId) },
      {
        id: "history",
        label: "Value history…",
        icon: "mdi-history",
        onClick: () => setHistoryFor(schemaId),
      },
      {
        id: "empty",
        label: "Empty property",
        icon: "mdi-eraser",
        onClick: () => emptyProperty(schemaId),
        disabled: readonly,
      },
      {
        id: "remove",
        label: "Remove from node",
        icon: "mdi-close-circle-outline",
        onClick: () => removeFromNode(schemaId),
        danger: true,
        disabled: bound || readonly,
      },
    ];
  };

  const nameRow = (propertySchemaId: string, label: string, hint: string | null) => (
    <button
      type="button"
      className="nt-props-sidebar__name nt-property-name"
      data-property-schema-id={propertySchemaId}
      onClick={() => setSettingsFor(propertySchemaId)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMenu({ schemaId: propertySchemaId, x: event.clientX, y: event.clientY });
      }}
    >
      {label}
      {hint !== null && <span className="nt-property-hint">{hint}</span>}
    </button>
  );

  return (
    <div className="nt-props-sidebar">
      <NodeViewSection
        title="Metadata"
        icon={<Icon path="mdi-format-list-bulleted" size={0.9} />}
        count={count}
        className="nt-props-sidebar__section"
        defaultExpanded={true}
      >
        {/* The aliases row is the panel's first section (relocated from the
            title-row button): the node's own aliases as pills + the add
            picker; the raw open keeps the retired popup's NAVIGATE bypass. */}
        <AliasesRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} onOpenPageRaw={onOpenPageRaw} />
        {/* The alias-side pseudo-property rides the sidebar's row stack too
            (only when the node IS an alias — the row renders null otherwise
            and the wrapper must not leave an empty slot). */}
        {client.getNode(nodeId)?.aliasedNodeId != null && (
          <div className="nt-props-sidebar__prop">
            <AliasedNodeRow client={client} nodeId={nodeId} onOpenPage={onOpenPage} />
          </div>
        )}
        {rendered.map((entry) => {
        if (entry === null) return null;
        if (entry.kind === "grouped") {
          const schema = entry.groupRows[0]?.schema ?? null;
          const label = schema?.name ?? entry.propertySchemaId;
          return (
            <div className="nt-props-sidebar__prop" key={entry.propertySchemaId}>
              {nameRow(entry.propertySchemaId, label, hintOf(entry.groupRows))}
              <div className="nt-props-sidebar__value">
                <GroupedPropertyRow
                  client={client}
                  nodeId={nodeId}
                  type={entry.type}
                  propertySchemaId={entry.propertySchemaId}
                  label={label}
                  multi={schema?.multi ?? true}
                  schema={schema}
                  bindingFilter={null}
                  groupRows={entry.groupRows}
                  onOpenPage={onOpenPage}
                  bare
                />
              </div>
            </div>
          );
        }
        const row = entry.row;
        return (
          <div className="nt-props-sidebar__prop" key={`${row.propertySchemaId}:${row.idx}`}>
            {nameRow(
              row.propertySchemaId,
              labelOf(row),
              row.source === "default"
                ? "default"
                : row.source === "authored" && row.boundBy === null
                  ? "unbound"
                  : null,
            )}
            <div className="nt-props-sidebar__value">
              <ScalarPropertyValue client={client} nodeId={nodeId} row={row} onOpenPage={onOpenPage} />
            </div>
          </div>
        );
      })}
      {emptyObjectBindings.map((binding) => (
        <div className="nt-props-sidebar__prop" key={`empty-${binding.propertySchemaId}`}>
          {nameRow(binding.propertySchemaId, binding.name, null)}
          <div className="nt-props-sidebar__value">
            <GroupedPropertyRow
              client={client}
              nodeId={nodeId}
              type={binding.type}
              propertySchemaId={binding.propertySchemaId}
              label={binding.name}
              multi={binding.multi}
              schema={{ datePrecision: binding.datePrecision }}
              bindingFilter={binding.targetClassFilter}
              groupRows={[]}
              onOpenPage={onOpenPage}
              bare
            />
          </div>
        </div>
      ))}
        <AddPropertyRow client={client} nodeId={nodeId} />
      </NodeViewSection>
      {menu !== null && (
        <ContextMenu items={menuItems(menu.schemaId)} position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />
      )}
      {historyFor !== null && (
        <PropertyHistoryModal
          client={client}
          nodeId={nodeId}
          propertySchemaId={historyFor}
          schemaName={
            client.listPropertySchemas().find((s) => s.id === historyFor)?.name ?? historyFor
          }
          onClose={() => setHistoryFor(null)}
        />
      )}
      {settingsFor !== null && (
        <PropertySettingsModal
          client={client}
          propertySchemaId={settingsFor}
          onClose={() => setSettingsFor(null)}
          onOpenView={() => {
            setViewFor(settingsFor);
            setSettingsFor(null);
          }}
        />
      )}
      {viewFor !== null && (
        <PropertyView
          client={client}
          propertySchemaId={viewFor}
          onClose={() => setViewFor(null)}
          onOpenPage={(id) => {
            setViewFor(null);
            onOpenPage?.(id);
          }}
        />
      )}
    </div>
  );
}

/**
 * PropertySettingsModal — the property's "page" for configuration (opened by
 * clicking a property label in the table). The schemas are registry rows,
 * so the configuration surface is this modal:
 * rename, per-type behavior (date precision / qualified, select options),
 * and the property-level render contracts (value display, read-
 * only, hide when empty), the single home for those. Type and multi are
 * create-time contracts and display read-only. The "Open property" footer
 * path surfaces the schema inspector (PropertyView): metadata,
 * bound classes, and the authored-value references.
 */
function PropertySettingsModal({
  client,
  propertySchemaId,
  onClose,
  onOpenView,
}: {
  client: AnyClient;
  propertySchemaId: string;
  onClose: () => void;
  onOpenView: () => void;
}) {
  const schema = client.listPropertySchemas().find((s) => s.id === propertySchemaId);
  const [convertOpen, setConvertOpen] = useState(false);
  /** The option whose icon picker is open (+ its anchor button). */
  const [iconPickerFor, setIconPickerFor] = useState<{
    optionId: string;
    anchor: HTMLElement;
  } | null>(null);
  if (schema === undefined) return null;

  const patch = (fields: Parameters<AnyClient["updatePropertySchema"]>[1]) =>
    void client.updatePropertySchema(propertySchemaId, fields);

  return (
    <Modal isOpen onClose={onClose} size="sm" showCloseButton={false} className="nt-property-settings">
      <div className="modal__header">
        <h2 className="modal__title">Property settings</h2>
        <button type="button" aria-label="Close modal" className="btn btn--ghost btn--sm btn--icon-only modal__close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="modal__content">
        <label className="nt-property-settings__field">
          <span className="nt-property-settings__label">Name</span>
          <input
            key={schema.id}
            type="text"
            className="nt-property-settings__input"
            defaultValue={schema.name}
            aria-label="Property name"
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name !== "" && name !== schema.name) patch({ name });
            }}
          />
        </label>
        <p className="nt-property-settings__meta">
          Type: {schema.type}
          {schema.multi ? " (multi)" : ""}
        </p>
        {/* The render contracts are PROPERTY-level — the single home
            for editing them is this settings surface. Value display rides
            the types the block-row button renders (select / multi_select /
            boolean); read-only and hide-when-empty are type-agnostic. The
            wire stores "panel" / null explicitly. */}
        {(schema.type === "select" || schema.type === "multi_select" || schema.type === "boolean") && (
          <label className="nt-property-settings__field">
            <span className="nt-property-settings__label">Value display</span>
            <SelectionButton
              size="sm"
              aria-label="Value display"
              options={[
                { value: "panel", icon: "mdi-format-list-bulleted-square", label: "Properties panel" },
                { value: "bullet", icon: "mdi-circle-medium", label: "Next to bullet" },
                { value: "inline", icon: "mdi-format-align-left", label: "Before content" },
              ]}
              value={schema.display ?? "panel"}
              onChange={(value) => patch({ display: value as PropertyDisplay })}
            />
          </label>
        )}
        <label className="nt-property-settings__field">
          <span className="nt-property-settings__label">Read-only</span>
          <ToggleSwitch
            size="sm"
            leftLabel="Editable"
            rightLabel="Read-only"
            checked={schema.readonly === true}
            onChange={(value) => patch({ readonly: value ? true : null })}
            aria-label="Read-only"
          />
        </label>
        <label className="nt-property-settings__field">
          <span className="nt-property-settings__label">Hide when empty</span>
          <ToggleSwitch
            size="sm"
            leftLabel="Always show"
            rightLabel="Hide when empty"
            checked={schema.hideWhenEmpty === true}
            onChange={(value) => patch({ hideWhenEmpty: value ? true : null })}
            aria-label="Hide when empty"
          />
        </label>
        {schema.type === "date" && (
          <>
            <label className="nt-property-settings__field">
              <span className="nt-property-settings__label">Precision</span>
              <select
                className="nt-property-settings__input"
                aria-label="Date precision"
                value={schema.datePrecision ?? "day"}
                onChange={(event) =>
                  patch({ datePrecision: event.target.value as DatePrecision })
                }
              >
                <option value="day">Day</option>
                <option value="month">Month</option>
                <option value="year">Year</option>
              </select>
            </label>
            <label className="nt-property-settings__check">
              <input
                type="checkbox"
                checked={schema.dateQualified ?? false}
                onChange={(event) => patch({ dateQualified: event.target.checked })}
                aria-label="Date range qualifiers"
              />
              <span>Allow start/end qualifiers</span>
            </label>
          </>
        )}
        {schema.type === "select" && (
          <div className="nt-property-settings__field">
            <span className="nt-property-settings__label">Options</span>
            <ul className="nt-property-settings__options">
              {(schema.options ?? []).map((option) => (
                <li key={option.id} className="nt-property-settings__option">
                  {/* Per-option MDI icon (the picker's trash action
                      emits "" = clear; the wholesale options write preserves
                      ids like the ColorButton path above). */}
                  <button
                    type="button"
                    className="nt-property-settings__option-icon"
                    title={`Icon for ${option.label}`}
                    aria-label={`Icon for ${option.label}`}
                    onClick={(event) =>
                      setIconPickerFor({ optionId: option.id, anchor: event.currentTarget })
                    }
                  >
                    {option.icon ? (
                      <Icon
                        path={option.icon}
                        size={0.7}
                        {...(option.color ? { color: cssColorFor(option.color) } : {})}
                      />
                    ) : (
                      <Icon path="mdi-plus-circle-outline" size={0.7} />
                    )}
                  </button>
                  {/* Per-option color dot (the color grammar; none = uncolored). */}
                  <ColorButton
                    color={option.color ?? ""}
                    size="xs"
                    showPicker
                    showNoneOption
                    aria-label={`Color for ${option.label}`}
                    onColorChange={(color) =>
                      patch({
                        options: (schema.options ?? []).map((o) =>
                          o.id === option.id ? { ...o, color } : o,
                        ),
                      })
                    }
                  />
                  <input
                    key={`${option.id}:${option.label}`}
                    type="text"
                    className="nt-property-settings__input"
                    defaultValue={option.label}
                    aria-label={`Option ${option.label}`}
                    onBlur={(event) => {
                      const label = event.target.value.trim();
                      if (label === "" || label === option.label) return;
                      patch({
                        options: (schema.options ?? []).map((o) =>
                          o.id === option.id ? { ...o, label } : o,
                        ),
                      });
                    }}
                  />
                  <button
                    type="button"
                    className="pill__right-button"
                    aria-label={`Remove option ${option.label}`}
                    onClick={() =>
                      patch({
                        options: (schema.options ?? []).filter((o) => o.id !== option.id),
                      })
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                patch({
                  options: [
                    ...(schema.options ?? []),
                    { id: crypto.randomUUID(), label: "New option" },
                  ],
                })
              }
            >
              + Add option
            </Button>
            {iconPickerFor !== null && (
              <IconPickerPopup
                value={
                  schema.options?.find((option) => option.id === iconPickerFor.optionId)?.icon ??
                  ""
                }
                anchorEl={iconPickerFor.anchor}
                onClose={() => setIconPickerFor(null)}
                onSelect={(value) =>
                  patch({
                    options: (schema.options ?? []).map((option) =>
                      option.id === iconPickerFor.optionId
                        ? { ...option, icon: value === "" ? null : value }
                        : option,
                    ),
                  })
                }
              />
            )}
          </div>
        )}
      </div>
      <div className="modal__footer">
        {/* PG3: the blessed delete+recreate conversion flow (one honest
            flow — Capacities-style keep-original machinery is NOT built). */}
        <Button variant="ghost" onClick={() => setConvertOpen(true)}>
          Convert…
        </Button>
        <Button variant="ghost" onClick={onOpenView}>
          Open property
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
      {convertOpen && (
        <PropertyConvertModal client={client} schema={schema} onClose={() => setConvertOpen(false)} />
      )}
    </Modal>
  );
}
