/**
 * PropertiesPanel — the effective-properties panel on Page/Block views
 * (SCHEMA.md "Class properties"): authored property values plus derived
 * class-binding defaults, read through getEffectiveProperties.
 *
 * Rendering contract:
 *  - derived defaults render DIMMED with a "default" hint — they are
 *    configuration projections, not authored data;
 *  - editing any row writes an authored property.set, which from then on
 *    SHADOWS the default (the row flips to source "authored" on re-render);
 *  - an authored value whose class binding went away stays visible, marked
 *    "unbound" (authored values always survive — design law).
 *
 * Node-typed properties (schema type "object") render as chips of linked
 * nodes plus an add affordance: a picker searching existing nodes filtered by
 * the schema's targetClassFilter, and — when the filter targets the asset
 * class — an "upload file" action (POST /api/v1/assets → asset node +
 * asset.attach + property.set). Chip removal unlinks the value's slot
 * (property.unset), the same per-idx write pattern the scalar editor uses.
 * Asset chips additionally carry an annotations affordance (❝) opening the
 * lazy Annotations section for that asset (SCHEMA.md annotation family:
 * highlight-classed objects linked via the seeded highlight_asset property):
 * the annotation list plus the add-annotation form (quote/page/note).
 *
 * The panel is node-typed agnostic: PageView mounts it for the page; any
 * future Block View can mount it for a block with the same props.
 *
 * The node's own classes render as chips above the property rows (the
 * panel's "Classes" affordance): each chip's × issues class.unassign — the
 * OR-Set remove drops the class's derived defaults from this panel's read
 * and leaves authored values in place, marked unbound.
 */

import { useRef, useState } from "react";

import {
  deriveDisplayName,
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

import { AnnotationsSection } from "./AnnotationsSection.js";
import { DatePicker } from "./DatePicker.js";

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
 * One node-typed property: chips of the linked nodes + the add/upload picker.
 * `rows` are the effective rows of this schema on the node (authored chips
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
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Chip ref whose annotations section is open (one at a time), null = none. */
  const [annotatingRef, setAnnotatingRef] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const targetClassIds = resolveTargetClassIds(client, propertySchemaId, bindingFilter);
  const assetClassId = targetClassIds?.find((id) => isAssetClass(client, id));
  const isAssetTarget = assetClassId !== undefined;
  const schemaRow = client.listPropertySchemas().find((s) => s.id === propertySchemaId);
  const dateQualified = schemaRow?.dateQualified === true;

  const chips = rows
    .map((row) => ({ row, ref: nodeRefOf(row.value) }))
    .filter((chip): chip is { row: EffectiveProperty; ref: string } => chip.ref !== null)
    .sort((a, b) => a.row.idx - b.row.idx);
  const linkedIds = new Set(chips.map((chip) => chip.ref));
  const authoredIdx = rows.filter((row) => row.source === "authored").map((row) => row.idx);
  // Per-slot write pattern: append at the next free idx (0 shadows a default).
  const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;

  const chipLabel = (ref: string): string => {
    if (isAssetTarget) {
      const info = client.getAssetInfo(ref);
      if (info !== undefined) return info.originalName;
    }
    return client.getDisplayName(ref) ?? ref;
  };

  const linkNode = async (target: string): Promise<void> => {
    await client.setProperty(nodeId, propertySchemaId, { nodeId: target }, nextIdx);
    setPickerOpen(false);
    setQuery("");
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

  const matchesFilter = (node: ClientNode): boolean =>
    targetClassIds === null || node.classIds.some((id) => targetClassIds.includes(id));
  const candidates: ClientNode[] = (() => {
    const q = query.trim();
    const hits =
      q === "" && targetClassIds !== null
        ? targetClassIds.flatMap((id) => client.getClassMembers(id))
        : client.search(q);
    const seen = new Set<string>();
    return hits
      .filter(matchesFilter)
      .filter((node) => !linkedIds.has(node.id))
      .filter((node) => {
        if (seen.has(node.id)) return false;
        seen.add(node.id);
        return true;
      });
  })();

  // No rows (bound, unvalued) is not a default state — no hint.
  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);

  return (
    <li
      className={
        allDefault ? "nt-property nt-property-default nt-property-object" : "nt-property nt-property-object"
      }
    >
      <span className="nt-property-name">{label}</span>
      {allDefault && <span className="nt-property-hint">default</span>}
      {unbound && <span className="nt-property-hint">unbound</span>}
      <span className="nt-property-chips">
        {chips.map(({ row, ref }) => {
          const removeLabel = `Remove ${chipLabel(ref)}`;
          const download = () => {
            const info = client.getAssetInfo(ref);
            if (info !== undefined) void client.downloadAsset(info.assetId);
          };
          return (
            <span
              key={`${propertySchemaId}:${row.idx}`}
              className={row.source === "default" ? "nt-chip nt-chip-default" : "nt-chip"}
            >
              {isAssetTarget ? (
                <button type="button" className="nt-chip-label" title="Download" onClick={download}>
                  {chipLabel(ref)}
                </button>
              ) : (
                <span className="nt-chip-label">{chipLabel(ref)}</span>
              )}
              {row.source === "authored" && (
                <button
                  type="button"
                  className="nt-chip-remove"
                  aria-label={removeLabel}
                  onClick={() => void unlink(row.idx)}
                >
                  ×
                </button>
              )}
              {isAssetTarget && (
                <button
                  type="button"
                  className="nt-chip-annotations"
                  title="Annotations"
                  aria-label={`Annotate ${chipLabel(ref)}`}
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
                  ariaLabel={chipLabel(ref)}
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
        {!(multi === false && chips.length > 0) && (
          <button
            type="button"
            className="nt-chip-add"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            + Add
          </button>
        )}
      </span>
      {annotatingRef !== null && (
        <AnnotationsSection
          client={client}
          assetId={annotatingRef}
          onOpenPage={onOpenPage}
        />
      )}
      {pickerOpen && (
        <div className="nt-property-picker">
          <input
            autoFocus
            type="text"
            className="nt-property-value"
            aria-label={`Search ${label}`}
            placeholder={`Search ${label}…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="nt-picker-list">
            {candidates.map((node) => (
              <li key={node.id}>
                <button type="button" className="nt-picker-item" onClick={() => void linkNode(node.id)}>
                  {deriveDisplayName(node) || node.id}
                </button>
              </li>
            ))}
            {candidates.length === 0 && <li className="nt-picker-empty">No matches.</li>}
          </ul>
          {isAssetTarget && (
            <>
              <button
                type="button"
                className="nt-picker-upload"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {busy ? "Uploading…" : "Upload file…"}
              </button>
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
            </>
          )}
          {error !== null && (
            <p role="alert" className="nt-picker-error">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * One date-typed property (SCHEMA.md "Dates"): the schema's effective rows
 * render as date chips; picking a date ensures the year/month/day chain and
 * links the node at the schema's precision ({ "nodeId": … }, the shape the
 * edge index projects — the year node backlinks everything dated that year).
 * Editing an existing chip's date overwrites the same slot's ref.
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
  const precision = precisionOf(schema);

  const ordered = [...rows].sort((a, b) => a.idx - b.idx);
  const authoredIdx = ordered.filter((row) => row.source === "authored").map((row) => row.idx);
  const nextIdx = authoredIdx.length > 0 ? Math.max(...authoredIdx) + 1 : 0;

  const commit = async (isoDate: string, idx: number): Promise<void> => {
    await client.setDateProperty(nodeId, propertySchemaId, isoDate, idx);
    setPickerFor(null);
  };

  const chipText = (row: EffectiveProperty): string => {
    const ref = nodeRefOf(row.value);
    if (ref !== null) return dateLabelOf(ref);
    return toEditableText(row.value); // scalar binding default, shown as-is
  };

  const allDefault = rows.length > 0 && rows.every((row) => row.source === "default");
  const unbound = rows.some((row) => row.source === "authored" && row.boundBy === null);

  return (
    <li
      className={
        allDefault ? "nt-property nt-property-default nt-property-date" : "nt-property nt-property-date"
      }
    >
      <span className="nt-property-name">{label}</span>
      {allDefault && <span className="nt-property-hint">default</span>}
      {unbound && <span className="nt-property-hint">unbound</span>}
      <span className="nt-property-chips">
        {ordered.map((row) => (
          <span
            key={`${propertySchemaId}:${row.idx}`}
            className={row.source === "default" ? "nt-chip nt-chip-default" : "nt-chip"}
          >
            <button
              type="button"
              className="nt-chip-label"
              aria-label={`Set ${label}`}
              aria-expanded={pickerFor === row.idx}
              onClick={() => setPickerFor((cur) => (cur === row.idx ? null : row.idx))}
            >
              {chipText(row)}
            </button>
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
          <button
            type="button"
            className="nt-chip-add"
            aria-expanded={pickerFor === "new"}
            onClick={() => setPickerFor((cur) => (cur === "new" ? null : "new"))}
          >
            + Add
          </button>
        )}
      </span>
      {pickerFor !== null && (
        <DatePicker
          precision={precision}
          selectedIso={
            pickerFor === "new"
              ? null
              : isoOfRef(nodeRefOf(ordered.find((row) => row.idx === pickerFor)?.value ?? null))
          }
          onCommit={(iso) => void commit(iso, pickerFor === "new" ? nextIdx : pickerFor)}
          onClose={() => setPickerFor(null)}
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
  const precision = precisionOf(schema);

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
          onClick={() =>
            setPicking((cur) =>
              cur !== null && cur.idx === idx && cur.end === end ? null : { idx, end },
            )
          }
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
          ? "nt-property nt-property-default nt-property-date-range"
          : "nt-property nt-property-date-range"
      }
    >
      <span className="nt-property-name">{label}</span>
      {allDefault && <span className="nt-property-hint">default</span>}
      {unbound && <span className="nt-property-hint">unbound</span>}
      <span className="nt-property-chips">
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
          <button
            type="button"
            className="nt-chip-add"
            aria-expanded={picking !== null && picking.idx === nextIdx}
            onClick={() =>
              setPicking((cur) =>
                cur !== null && cur.idx === nextIdx ? null : { idx: nextIdx, end: "start" },
              )
            }
          >
            + Add
          </button>
        )}
      </span>
      {picking !== null && (
        <DatePicker
          precision={precision}
          selectedIso={isoOfRef(rangeValueOf(ordered.find((r) => r.idx === picking.idx)?.value)[picking.end])}
          onCommit={(iso) => void setEnd(picking.idx, picking.end, iso)}
          onClose={() => setPicking(null)}
        />
      )}
    </li>
  );
}

/**
 * Link qualifier range control (SCHEMA.md "Dates", dateQualified schemas):
 * small start/end date inputs next to a node-typed chip; values persist as
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

export function PropertiesPanel({
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

  // Node-typed / date / date_range schemas render as one grouped row per
  // schema; scalar rows keep the minimal text editor. Grouped rows appear at
  // their first occurrence so the panel order is unchanged.
  const renderedGroups = new Set<string>();
  const rendered = rows.map((row) => {
    const type = row.schema?.type;
    if (type !== "object" && type !== "date" && type !== "date_range") {
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
      if (
        binding.type !== "object" &&
        binding.type !== "date" &&
        binding.type !== "date_range"
      ) {
        continue;
      }
      if (renderedGroups.has(binding.propertySchemaId)) continue;
      if (emptyObjectBindings.some((b) => b.propertySchemaId === binding.propertySchemaId)) continue;
      if (binding.hideWhenEmpty === true) continue;
      emptyObjectBindings.push(binding);
    }
  }

  // The node's own classes: chips with an × that unassigns (class.unassign).
  const classIds = node?.classIds ?? [];

  if (rows.length === 0 && emptyObjectBindings.length === 0 && classIds.length === 0) return null;

  const groupedRow = (
    type: string,
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

  return (
    <section className="nt-class-panel nt-properties-panel" aria-label="Properties">
      <h2 className="nt-class-panel-title">Properties</h2>
      {classIds.length > 0 && (
        <ul className="nt-class-chips" aria-label="Classes">
          {classIds.map((classId) => {
            const label = client.getDisplayName(classId) ?? classId;
            return (
              <li key={classId} className="nt-class-chip">
                <span className="nt-class-chip-name">{label}</span>
                <button
                  type="button"
                  className="nt-class-chip-remove"
                  aria-label={`Remove class ${label}`}
                  onClick={() => void client.unassignClass(nodeId, classId)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
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
                row.source === "default" ? "nt-property nt-property-default" : "nt-property"
              }
            >
              <span className="nt-property-name">{label}</span>
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
    </section>
  );
}
