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

import { deriveDisplayName, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type {
  ClassBinding,
  ClientNode,
  EffectiveProperty,
  WorkspaceClient,
} from "@/core/workspace-client.js";

import { AnnotationsSection } from "./AnnotationsSection.js";

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

  // Node-typed schemas render as one chip row per schema; scalar rows keep the
  // minimal text editor. Object rows are grouped at their first appearance so
  // the panel order is unchanged.
  const renderedGroups = new Set<string>();
  const rendered = rows.map((row) => {
    if (row.schema?.type !== "object") return { kind: "scalar" as const, row };
    if (renderedGroups.has(row.propertySchemaId)) return null;
    renderedGroups.add(row.propertySchemaId);
    return {
      kind: "object" as const,
      propertySchemaId: row.propertySchemaId,
      groupRows: rows.filter((r) => r.propertySchemaId === row.propertySchemaId),
    };
  });

  // A bound object-typed property with no effective rows still renders: the
  // chips row hosts the add/upload affordance (the scalar editor has no way
  // to author a first node link). hideWhenEmpty bindings are the exception.
  const emptyObjectBindings: ClassBinding[] = [];
  const node = client.getNode(nodeId);
  for (const classId of node?.classIds ?? []) {
    for (const binding of client.getClassBindings(classId)) {
      if (binding.type !== "object" || renderedGroups.has(binding.propertySchemaId)) continue;
      if (emptyObjectBindings.some((b) => b.propertySchemaId === binding.propertySchemaId)) continue;
      if (binding.hideWhenEmpty === true) continue;
      emptyObjectBindings.push(binding);
    }
  }

  // The node's own classes: chips with an × that unassigns (class.unassign).
  const classIds = node?.classIds ?? [];

  if (rows.length === 0 && emptyObjectBindings.length === 0 && classIds.length === 0) return null;

  const objectRow = (
    propertySchemaId: string,
    label: string,
    multi: boolean,
    bindingFilter: string[] | null,
    groupRows: EffectiveProperty[],
  ) => (
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
          if (entry.kind === "object") {
            const schema = entry.groupRows[0]?.schema;
            return objectRow(
              entry.propertySchemaId,
              schema?.name ?? entry.propertySchemaId,
              schema?.multi ?? true,
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
          objectRow(
            binding.propertySchemaId,
            binding.name,
            binding.multi,
            binding.targetClassFilter,
            [],
          ),
        )}
      </ul>
    </section>
  );
}
