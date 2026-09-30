/**
 * MetadataSection — the page's effective-properties panel.
 *
 * Rows:
 *  - the node's classes as colored pills (× unassigns; right-click opens the
 *    color-swatch menu) + a "+ Add class" ghost pill opening the ported
 *    node-selector popup (search / create / pick, client.assignClass);
 *  - node-typed / date / date_range values render as pills; the object picker
 *    is the ported NodeSelector popup (search + create, filtered by the
 *    schema's target classes, upload for asset targets), date rows open the
 *    ported DatePickerPopup (drill-down calendar + typed-date input);
 *  - select schemas with options render the ported options control
 *    (pills + picker), booleans a checkbox, everything else the minimal
 *    text editor. Derived defaults stay dimmed with a "default" hint, authored
 *    values win, unbound survivors are marked.
 *
 * The nt-* class hooks the tests assert on (.nt-properties-panel,
 * .nt-property-*, .nt-classes-row, …) are unchanged.
 */

import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  parseDateNodeId,
  SYSTEM_CLASS_UUIDS,
  type DatePrecision,
} from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type {
  ClassBinding,
  ClientNode,
  EffectiveProperty,
  WorkspaceClient,
} from "@/core/workspace-client.js";

import { AnnotationsSection } from "../AnnotationsSection.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { NodeViewSection } from "./NodeViewSection.js";
import { Checkbox } from "./ui/Checkbox.js";
import { AddPill } from "./ui/AddPill.js";
import { ColorPickerRow } from "./pickers/ColorPickerRow.js";
import { NodeContextMenu } from "./NodeContextMenu.js";
import { ReferenceSubtree } from "./ReferenceSubtree.js";
import { DatePickerPopup } from "./pickers/DatePickerPopup.js";
import { NodeSelector } from "./pickers/NodeSelector.js";
import { SelectionPropertyControl } from "./pickers/SelectionPropertyControl.js";
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
 * Day keys (`y-m0-d`, 0-indexed month) backed by an existing day node — the
 * date picker's has-note marks.
 */
function collectMarkedDates(client: AnyClient): Set<string> {
  const dates = new Set<string>();
  for (const node of client.listPages()) {
    if (!node.classIds.includes(SYSTEM_CLASS_UUIDS.day)) continue;
    const parsed = parseDateNodeId(node.id);
    if (parsed !== null) {
      dates.add(`${parsed.year}-${parsed.month - 1}-${parsed.day}`);
    }
  }
  return dates;
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
 * picks the black/white token (class colors are stored hex, see ClassView).
 */
function contrastFor(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return "var(--color-on-primary-container)";
  const rgb = parseInt(match[1]!, 16);
  const channel = (shift: number) => ((rgb >> shift) & 0xff) / 255;
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.45 ? "var(--color-black)" : "var(--color-white)";
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
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Pill ref whose annotations section is open (one at a time), null = none. */
  const [annotatingRef, setAnnotatingRef] = useState<string | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const linkNode = async (target: string): Promise<void> => {
    await client.setProperty(nodeId, propertySchemaId, { nodeId: target }, nextIdx);
    setPickerOpen(false);
  };

  const unlink = async (idx: number): Promise<void> => {
    await client.unsetProperty(nodeId, propertySchemaId, idx);
  };

  const uploadFile = async (file: File): Promise<void> => {
    if (assetClassId === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await client.uploadAsset(file, file.name);
      // The Zotero-style asset node: a node carrying the asset class, named by
      // the uploaded file; the property links to it, node_asset ties it to the
      // content-addressed bytes.
      const assetNodeId = await client.createObject({
        nodeType: "page",
        name: uploaded.originalName,
        classIds: [assetClassId],
      });
      await client.attachAsset(assetNodeId, uploaded);
      await client.setProperty(nodeId, propertySchemaId, { nodeId: assetNodeId }, nextIdx);
      setPickerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // No rows (bound, unvalued) is not a default state — no hint.
  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);

  return (
    <li
      className={
        allDefault
          ? "nt-property nt-property-default nt-property-object node-metadata-row"
          : "nt-property nt-property-object node-metadata-row"
      }
    >
      <span className="section-label nt-property-name">{label}</span>
      {allDefault && <span className="nt-property-hint">default</span>}
      {unbound && <span className="nt-property-hint">unbound</span>}
      <span className="nt-property-chips node-metadata-pills">
        {pills.map(({ row, ref }) => {
          const removeLabel = `Remove ${pillLabel(ref)}`;
          const download = () => {
            const info = client.getAssetInfo(ref);
            if (info !== undefined) void client.downloadAsset(info.assetId);
          };
          const linkedNode = client.getNode(ref);
          return (
            <span
              key={`${propertySchemaId}:${row.idx}`}
              className={
                row.source === "default"
                  ? "pill pill--default"
                  : "pill pill--hover-reveal-right"
              }
            >
              {linkedNode?.icon !== null && linkedNode?.icon !== undefined && (
                <span className="pill__left-icon">
                  <Icon path={linkedNode.icon} size={0.7} />
                </span>
              )}
              {isAssetTarget ? (
                <button type="button" className="pill__text nt-chip-label" title="Download" onClick={download}>
                  {pillLabel(ref)}
                </button>
              ) : linkedNode?.nodeType === "block" ? (
                // Text properties are node-backed carrier blocks: the value
                // cell renders the block itself, editable — never a raw id.
                <span className="nt-property-blockcell">
                  <ReferenceSubtree client={client} rootId={ref} onOpenNode={onOpenPage} />
                </span>
              ) : (
                <span className="pill__text nt-chip-label">{pillLabel(ref)}</span>
              )}
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
              {isAssetTarget && (
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
              )}
              {dateQualified && (
                <QualifierRange
                  start={typeof row.metadata?.startDate === "string" ? row.metadata.startDate : ""}
                  end={typeof row.metadata?.endDate === "string" ? row.metadata.endDate : ""}
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
              )}
            </span>
          );
        })}
        {!(multi === false && pills.length > 0) && (
          <AddPill
            ref={addButtonRef}
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
          allowCreate={!isAssetTarget}
          alwaysShowCreate={isAssetTarget}
          createLabel={isAssetTarget ? "Upload file…" : undefined}
          onCreateNew={
            isAssetTarget
              ? () => {
                  fileInputRef.current?.click();
                }
              : (name) =>
                  client.createObject({
                    nodeType: "page",
                    name,
                    ...(targetClassIds !== null ? { classIds: targetClassIds } : {}),
                  })
          }
        />
      )}
      {isAssetTarget && (
        <input
          ref={fileInputRef}
          type="file"
          className="nt-file-input"
          aria-label={`Upload ${label}`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void uploadFile(file);
            event.target.value = "";
          }}
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
 * One date-typed property (SCHEMA.md "Dates"): the schema's effective rows
 * render as date pills; picking a date ensures the year/month/day chain and
 * links the node at the schema's precision ({ "nodeId": … }, the shape the
 * edge index projects — the year node backlinks everything dated that year).
 * Editing an existing pill's date overwrites the same slot's ref.
 */
function DatePropertyRow({
  client,
  nodeId,
  propertySchemaId,
  label,
  multi,
  schema,
  rows,
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  schema: { datePrecision?: DatePrecision | null } | null;
  rows: EffectiveProperty[];
}) {
  const [pickerFor, setPickerFor] = useState<number | "new" | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const precision = precisionOf(schema);
  const markedDates = collectMarkedDates(client);

  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const authoredIdx = ordered.filter((row) => row.source === "authored").map((row) => row.idx);
  const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;

  const commit = async (isoDate: string, idx: number): Promise<void> => {
    await client.setDateProperty(nodeId, propertySchemaId, isoDate, idx);
    setPickerFor(null);
  };

  const pillText = (row: EffectiveProperty): string => {
    const ref = nodeRefOf(row.value);
    if (ref !== null) return dateLabelOf(ref);
    return toEditableText(row.value); // scalar binding default, shown as-is
  };

  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);

  return (
    <li
      className={
        allDefault
          ? "nt-property nt-property-default nt-property-date node-metadata-row"
          : "nt-property nt-property-date node-metadata-row"
      }
    >
      <span className="section-label nt-property-name">{label}</span>
      {allDefault && <span className="nt-property-hint">default</span>}
      {unbound && <span className="nt-property-hint">unbound</span>}
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
          </span>
        ))}
        {!(multi === false && ordered.length > 0) && (
          <AddPill
            label="Add"
            aria-expanded={pickerFor === "new"}
            onClick={(element) => {
              anchorRef.current = element;
              setPickerFor((cur) => (cur === "new" ? null : "new"));
            }}
          />
        )}
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
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  schema: { datePrecision?: DatePrecision | null } | null;
  rows: EffectiveProperty[];
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
        <button
          type="button"
          className="nt-chip-label"
          aria-label={`Set ${title.toLowerCase()} for ${label}`}
          aria-expanded={picking?.idx === idx && picking.end === end}
          onClick={(event) => {
            anchorRef.current = event.currentTarget;
            setPicking((cur) =>
              cur !== null && cur.idx === idx && cur.end === end ? null : { idx, end },
            );
          }}
        >
          {ref !== null ? dateLabelOf(ref) : "…"}
        </button>
        {row?.source === "authored" && ref !== null && (
          <button
            type="button"
            className="nt-chip-remove"
            aria-label={`Clear ${title.toLowerCase()} for ${label}`}
            onClick={() => void setEnd(idx, end, null)}
          >
            ×
          </button>
        )}
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
      <span className="section-label nt-property-name">{label}</span>
      {allDefault && <span className="nt-property-hint">default</span>}
      {unbound && <span className="nt-property-hint">unbound</span>}
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
 * Link qualifier range control (SCHEMA.md "Dates", dateQualified schemas):
 * small start/end date inputs next to a node-typed pill; values persist as
 * property.set metadata.startDate/endDate (ISO strings — node-backed date
 * qualifiers are the possible M2 evolution).
 */
function QualifierRange({
  start,
  end,
  ariaLabel,
  onCommit,
}: {
  start: string;
  end: string;
  ariaLabel: string;
  onCommit: (start: string, end: string) => void;
}) {
  const [startValue, setStartValue] = useState(start);
  const [endValue, setEndValue] = useState(end);
  return (
    <span className="nt-chip-qualifier">
      <input
        type="date"
        className="nt-chip-qualifier-input"
        aria-label={`${ariaLabel} start date`}
        value={startValue}
        onChange={(event) => {
          setStartValue(event.target.value);
          onCommit(event.target.value, endValue);
        }}
      />
      <span aria-hidden="true">–</span>
      <input
        type="date"
        className="nt-chip-qualifier-input"
        aria-label={`${ariaLabel} end date`}
        value={endValue}
        onChange={(event) => {
          setEndValue(event.target.value);
          onCommit(startValue, event.target.value);
        }}
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
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  multi: boolean;
  options: Array<{ id: string; label: string }>;
  rows: EffectiveProperty[];
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
          <span className="section-label nt-property-name">{label}</span>
          {allDefault && <span className="nt-property-hint">default</span>}
          {unbound && <span className="nt-property-hint">unbound</span>}
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
          <span className="section-label nt-property-name">{label}</span>
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
}: {
  client: AnyClient;
  nodeId: string;
  propertySchemaId: string;
  label: string;
  rows: EffectiveProperty[];
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
          <span className="section-label nt-property-name">{label}</span>
          {allDefault && <span className="nt-property-hint">default</span>}
          {unbound && <span className="nt-property-hint">unbound</span>}
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
          <span className="section-label nt-property-name">{label}</span>
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
 * ghost pill opening the node-selector popup (assignClass).
 */
function ClassesRow({
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
  // (nodeMenu state lives below, next to the color menu.)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [colorMenu, setColorMenu] = useState<{ classId: string; x: number; y: number } | null>(null);
  const [nodeMenu, setNodeMenu] = useState<{ node: ClientNode; x: number; y: number } | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  const assignedClasses = classIds
    .map((classId) => client.getNode(classId))
    .filter((node): node is ClientNode => node !== undefined);

  return (
    <div className="node-metadata-row nt-classes-row">
      <div className="section-label">Classes:</div>
      <div className="nt-property-chips node-metadata-pills">
        {classIds.map((classId) => {
          const cls = client.getNode(classId);
          const label = displayNameFromClient(client, classId) ?? classId;
          const colored =
            cls?.color !== null && cls?.color !== undefined ? cls.color : null;
          return (
            <span
              key={classId}
              className="pill pill--hover-reveal-right"
              style={
                colored !== null
                  ? { background: colored, color: contrastFor(colored) }
                  : undefined
              }
              onContextMenu={(event) => {
                if (cls === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                setNodeMenu({ node: cls, x: event.clientX, y: event.clientY });
              }}
            >
              {cls?.icon !== null && cls?.icon !== undefined && (
                <span className="pill__left-icon">
                  <Icon path={cls.icon} size={0.7} />
                </span>
              )}
              <button
                type="button"
                className="pill__text"
                onClick={() => onOpenPage?.(classId)}
              >
                {label}
              </button>
              <button
                type="button"
                className="pill__right-button"
                aria-label={`Remove class ${label}`}
                onClick={() => void client.unassignClass(nodeId, classId)}
              >
                ×
              </button>
            </span>
          );
        })}
        <span className="nt-class-add-anchor">
          <AddPill
            ref={addButtonRef}
            label="Add class"
            aria-expanded={pickerOpen}
            onClick={(element) => {
              addButtonRef.current = element;
              setPickerOpen((open) => !open);
            }}
          />
        </span>
      </div>
      {pickerOpen && (
        <NodeSelector
          client={client}
          searchMode="classes"
          nodes={assignedClasses}
          anchorEl={addButtonRef.current}
          onClose={() => setPickerOpen(false)}
          searchPlaceholder="Search classes"
          onAdd={(node) => {
            void client.assignClass(nodeId, node.id);
            setPickerOpen(false);
          }}
        />
      )}
      {colorMenu !== null && (
        <>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop closes on click */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: "var(--z-9998)" }}
            onClick={() => setColorMenu(null)}
          />
          {createPortal(
            <div
              style={{
                position: "fixed",
                left: colorMenu.x,
                top: colorMenu.y,
                zIndex: "var(--z-9999)",
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <ColorPickerRow
                currentColor={client.getNode(colorMenu.classId)?.color ?? null}
                onColorChange={(color) => {
                  // object.update has no null color (protocol: string only) —
                  // "No color" is a no-op until the protocol grows a clear.
                  if (color !== null) {
                    void client.updateObject(colorMenu.classId, { color });
                  }
                  setColorMenu(null);
                }}
              />
            </div>,
            document.body,
          )}
        </>
      )}
      <NodeContextMenu
        state={nodeMenu === null ? null : { ...nodeMenu, ownerId: nodeId, isPage: true }}
        client={client}
        onClose={() => setNodeMenu(null)}
        onOpenNode={(id) => onOpenPage?.(id)}
        onChangeColor={(x, y) => {
          if (nodeMenu !== null) setColorMenu({ classId: nodeMenu.node.id, x, y });
        }}
      />
    </div>
  );
}


/**
 * TagsRow — the "Tags:" metadata row (page-scoped): any page can be assigned
 * as a tag. Pills mirror the classes row; right-click opens the node menu
 * (remove goes through unassignTag).
 */
function TagsRow({
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

  const assignedTags = tagIds
    .map((tagId) => client.getNode(tagId))
    .filter((node): node is ClientNode => node !== undefined);

  return (
    <div className="node-metadata-row nt-tags-row">
      <div className="section-label">Tags:</div>
      <div className="nt-property-chips node-metadata-pills">
        {assignedTags.map((tag) => {
          const label = displayNameFromClient(client, tag.id) ?? tag.id;
          return (
            <span
              key={tag.id}
              className="nt-property-pill"
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setNodeMenu({ node: tag, x: event.clientX, y: event.clientY });
              }}
            >
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
          excludeNodeId={nodeId}
          alwaysShowCreate
          searchPlaceholder="Search pages…"
          onClose={() => setPickerOpen(false)}
          onNodeClick={(tag) => {
            setPickerOpen(false);
            void client.assignTag(nodeId, tag.id);
          }}
          onCreateNew={(name) => {
            setPickerOpen(false);
            void client.createObject({ nodeType: "page", name }).then((tagId) => {
              void client.assignTag(nodeId, tagId);
            });
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

export function MetadataSection({
  client,
  nodeId,
  onOpenPage,
}: {
  client: AnyClient;
  nodeId: string;
  /** Page navigation for the annotations section's annotation rows. */
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const rows = client.getEffectiveProperties(nodeId);

  const labelOf = (row: EffectiveProperty): string => row.schema?.name ?? row.propertySchemaId;

  // Node-typed / date / date_range / boolean schemas render as one grouped
  // row per schema; select schemas join them only when they declare options
  // (without options the minimal text editor is the honest editor — there is
  // nothing to pick). Scalar rows keep the minimal text editor. Grouped rows
  // appear at their first occurrence so the panel order is unchanged.
  const optionsOf = (propertySchemaId: string) =>
    client.listPropertySchemas().find((s) => s.id === propertySchemaId)?.options;
  const isGroupedType = (type: string | undefined, propertySchemaId: string): boolean => {
    if (type === "object" || type === "date" || type === "date_range" || type === "boolean") {
      return true;
    }
    if (type === "select") {
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
  // first value). hideWhenEmpty bindings are the exception.
  const emptyObjectBindings: ClassBinding[] = [];
  const node = client.getNode(nodeId);
  for (const classId of node?.classIds ?? []) {
    for (const binding of client.getClassBindings(classId)) {
      if (!isGroupedType(binding.type, binding.propertySchemaId)) continue;
      if (renderedGroups.has(binding.propertySchemaId)) continue;
      if (emptyObjectBindings.some((b) => b.propertySchemaId === binding.propertySchemaId)) continue;
      if (binding.hideWhenEmpty === true) continue;
      emptyObjectBindings.push(binding);
    }
  }

  // The node's own classes: pills with an × that unassigns (class.unassign).
  const classIds = node?.classIds ?? [];
  const tagIds = node?.tagIds ?? [];


  const groupedRow = (
    type: string | undefined,
    propertySchemaId: string,
    label: string,
    multi: boolean,
    schema: { datePrecision?: DatePrecision | null } | null,
    bindingFilter: string[] | null,
    groupRows: EffectiveProperty[],
  ) => {
    if (type === "date") {
      return (
        <DatePropertyRow
          key={propertySchemaId}
          client={client}
          nodeId={nodeId}
          propertySchemaId={propertySchemaId}
          label={label}
          multi={multi}
          schema={schema}
          rows={groupRows}
        />
      );
    }
    if (type === "date_range") {
      return (
        <DateRangePropertyRow
          key={propertySchemaId}
          client={client}
          nodeId={nodeId}
          propertySchemaId={propertySchemaId}
          label={label}
          multi={multi}
          schema={schema}
          rows={groupRows}
        />
      );
    }
    if (type === "select") {
      const options =
        client.listPropertySchemas().find((s) => s.id === propertySchemaId)?.options ?? [];
      return (
        <SelectPropertyRow
          key={propertySchemaId}
          client={client}
          nodeId={nodeId}
          propertySchemaId={propertySchemaId}
          label={label}
          multi={multi}
          options={options}
          rows={groupRows}
        />
      );
    }
    if (type === "boolean") {
      return (
        <BooleanPropertyRow
          key={propertySchemaId}
          client={client}
          nodeId={nodeId}
          propertySchemaId={propertySchemaId}
          label={label}
          rows={groupRows}
        />
      );
    }
    return (
      <ObjectPropertyRow
        key={propertySchemaId}
        client={client}
        nodeId={nodeId}
        propertySchemaId={propertySchemaId}
        label={label}
        multi={multi}
        bindingFilter={bindingFilter}
        rows={groupRows}
        onOpenPage={onOpenPage}
      />
    );
  };

  const count = classIds.length + tagIds.length + rows.length + emptyObjectBindings.length;

  return (
    <NodeViewSection
      title="Metadata"
      icon={<Icon path="mdi-tag-multiple-outline" size={0.9} />}
      count={count}
      className="node-metadata-section nt-properties-panel"
      defaultExpanded
    >
      <div className="node-metadata-content">
        <ClassesRow client={client} nodeId={nodeId} classIds={classIds} onOpenPage={onOpenPage} />
        {node !== undefined && node.nodeType === "page" && (
          <TagsRow client={client} nodeId={nodeId} tagIds={node.tagIds} onOpenPage={onOpenPage} />
        )}
        <ul className="nt-properties-list">
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
            const editable = toEditableText(row.value);
            return (
              <li
                key={`${row.propertySchemaId}:${row.idx}`}
                className={
                  row.source === "default"
                    ? "nt-property nt-property-default node-metadata-row"
                    : "nt-property node-metadata-row"
                }
              >
                <span className="section-label nt-property-name">{label}</span>
                {row.source === "default" && <span className="nt-property-hint">default</span>}
                {row.source === "authored" && row.boundBy === null && (
                  <span className="nt-property-hint">unbound</span>
                )}
                <input
                  key={`${row.propertySchemaId}:${row.idx}:${editable}`}
                  type="text"
                  className="nt-property-value"
                  defaultValue={editable}
                  aria-label={`Property ${label}`}
                  onBlur={(event) => {
                    const next = fromEditableText(event.target.value);
                    // Deep-compare so a no-op blur never enqueues a write.
                    if (JSON.stringify(next) !== JSON.stringify(row.value)) {
                      void client.setProperty(nodeId, row.propertySchemaId, next, row.idx);
                    }
                  }}
                />
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
      </div>
    </NodeViewSection>
  );
}
