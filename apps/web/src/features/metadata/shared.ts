/**
 * Shared helpers of the metadata panel (the `components/metadata/` folder):
 * the client union the panel components accept, the minimal text editor's
 * round-trip, the node-reference readers, the asset/class resolution
 * helpers, and the readable-text-on-color contrast pick. Pure moves from
 * the historical `MetadataSection.tsx`.
 */

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_DISPLAY_NAMES, SYSTEM_PROPERTY_SPECS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client/index.js";

import { resolveCssColor } from "../../components/ui/fleet/colorPresets.js";

/** The panel's client union — in-process or worker-backed. */
export type AnyClient = WorkspaceClient | WorkerClient;

/**
 * Types a class-binding defaultValue can meaningfully carry (PC2 +): text/number/boolean/select ONLY. Node-typed schemas
 * (object/asset/image/datetime) reject defaults at the wire ("a default that
 * links a node is meaningless"); url/email/multi_select pass the validator
 * but a class default for them carries no meaning — both the class-page
 * binding card and the create modal hide the default field for these.
 */
export function defaultCapable(type: string): boolean {
  return ["text", "number", "boolean", "select"].includes(type);
}

/**
 * The domain-seed self-heal for a MISSING system schema row (the
 * ensure-cover-property precedent): a workspace whose registry never
 * materialized a system property schema (pre-seed era; a test workspace
 * riding the read-synthesized fallback) gets the row authored idempotently
 * at the reserved id when the definition modal opens for it — the modal
 * edits the ROW (writes against a missing row would no-op). No-op when the
 * row exists or the id is not a system property uuid.
 */
export async function ensureSeedSchemaRow(client: AnyClient, schemaId: string): Promise<void> {
  if (client.listPropertySchemas().some((schema) => schema.id === schemaId)) return;
  const entry = (
    Object.entries(SYSTEM_PROPERTY_UUIDS) as Array<[string, string]>
  ).find(([, id]) => id === schemaId);
  if (entry === undefined) return;
  const [name, id] = entry;
  const spec = SYSTEM_PROPERTY_SPECS[name as keyof typeof SYSTEM_PROPERTY_SPECS];
  if (spec === undefined) return;
  await client.createPropertySchema({
    id,
    name: SYSTEM_PROPERTY_DISPLAY_NAMES[name as keyof typeof SYSTEM_PROPERTY_DISPLAY_NAMES],
    type: spec.type,
    multi: spec.multi ?? false,
    ...(spec.global === true ? {} : { scopeClassIds: [SYSTEM_CLASS_UUIDS[spec.bindTo!]] }),
    ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
    ...(spec.options !== undefined ? { options: spec.options } : {}),
    ...(spec.targetClassFilter !== undefined
      ? { targetClassFilter: spec.targetClassFilter.map((c) => SYSTEM_CLASS_UUIDS[c]) }
      : {}),
  });
}

/** Text-round-trip of an authored/default value for the minimal editor. */
export function toEditableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

/** Inverse: bare text stays a string; JSON-looking text parses (42, true, …). */
export function fromEditableText(text: string): unknown {
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
export function nodeRefOf(value: unknown): string | null {
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
export function resolveTargetClassIds(
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
export function isAssetClass(client: AnyClient, classId: string): boolean {
  return classId === SYSTEM_CLASS_UUIDS.asset || client.getNode(classId)?.name === "asset";
}

/**
 * Readable text on a class-color background: relative-luminance threshold
 * picks the black/white token. Stored colors are preset tokens (`sky`) or
 * custom hex, so resolve to a concrete hex before computing.
 */
export function contrastFor(color: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(resolveCssColor(color).trim());
  if (match === null) return "var(--md-sys-color-on-primary-container)";
  const rgb = parseInt(match[1]!, 16);
  const channel = (shift: number) => ((rgb >> shift) & 0xff) / 255;
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.45 ? "var(--md-sys-color-black)" : "var(--md-sys-color-white)";
}
