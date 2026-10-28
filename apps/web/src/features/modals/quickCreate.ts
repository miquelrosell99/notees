/**
 * Quick-create — the class-driven create resolution + creator behind the
 * QuickCreateModal (EVERY class picked from the quick-create
 * flow opens the modal — the source/agent family specializations retired).
 * The modal's properties form loads dynamically from the picked class's
 * bound properties (extends-aware, alphabetical — the design law), values
 * STAGED in modal state and flushed to the op log only on Create (cancel
 * leaves zero log entries). Title-is-content: the title is the node's
 * initial text content.
 *
 * The citation-family behaviors (auto-citekey, the duplicate warning, the
 * publicationDate date-chain write) key off the class LINEAGE
 * (collectSelfAndAncestors vs SYSTEM_CLASS_UUIDS.source), never hardcoded
 * field sets: the staged form renders whatever the class binds, and the
 * family logic reads the staged rows by their system schema ids.
 *
 * The module is client-agnostic (composes only the shared client surface)
 * so it runs under both WorkspaceClient and WorkerClient, and unit-tests
 * pure.
 */

import {
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  type SystemClassName,
  type SystemPropertyName,
} from "@notees/domain";

import { titleOfNode } from "../../ui/dateDisplay.js";

import type {
  AssetUploadResult,
  ClassBinding,
  ClientNode,
  ClientPropertyOption,
  ClientPropertySchema,
  CreateObjectInput,
  CreatePropertySchemaInput,
  SetClassPropertyInput,
} from "@/core/workspace-client/index.js";
import {
  DEFAULT_CITEKEY_PATTERN,
  renderCitekeyPattern,
  type CitekeyEntry,
} from "../sources/citekey.js";

/**
 * The structural client surface the quick-create resolution + creator
 * compose. Satisfied by WorkspaceClient and the WorkerClient proxy (both
 * full surfaces); the node picker extends its own minimal client interface
 * from this so the modal can mount inside the picker with no casts. The
 * source-flow seams added 2026-10-24 are OPTIONAL: minimal hosts without
 * them get the honest fallbacks (no archived-bit read, no undo batching, no
 * CAS attach), the full clients carry every one.
 */
export interface QuickCreateClient {
  listClasses(): ClientNode[];
  getClassParents(classId: string): string[];
  getClassMembers(classId: string): ClientNode[];
  listPropertySchemas(): ClientPropertySchema[];
  /**
   * The class's bound properties (extends-aware, alphabetical by property
   * name — the staged form's row source).
   */
  getClassBindings(classId: string): ClassBinding[];
  createObject(partial: CreateObjectInput): Promise<string>;
  setProperty(
    objectId: string,
    propertySchemaId: string,
    value: unknown,
    idx?: number,
  ): Promise<void>;
  createPropertySchema(input: CreatePropertySchemaInput): Promise<string>;
  setClassProperty(
    classId: string,
    propertySchemaId: string,
    fields: SetClassPropertyInput,
  ): Promise<void>;
  ensureDateChain(isoDate: string): Promise<{ year: string; month: string; day: string }>;
  /** The raw node row (the `active` archival bit read) — absent on minimal hosts. */
  getNodeRaw?(id: string): ClientNode | undefined;
  /** The effective property read (duplicate DOI/ISBN/citekey + citekey collision scans). */
  getEffectiveProperties?(id: string): Array<{
    propertySchemaId: string;
    value: unknown;
  }>;
  /**
   * The batched classed-create gesture (un-archive + create + the staged
   * property writes, ONE undo entry) — absent on minimal hosts.
   */
  beginClassedCreate?(input: {
    classId: string;
    title: string;
    unarchive: boolean;
    properties?: Array<{ propertySchemaId: string; value: unknown; idx?: number }>;
  }): Promise<string>;
  /** CAS upload + link (the resolved-PDF attach) — absent on minimal hosts. */
  uploadAsset?(file: Blob, filename: string): Promise<AssetUploadResult>;
  attachAsset?(objectId: string, asset: AssetUploadResult): Promise<void>;
  /** The workspace feature rows (the sources settings read) — absent on minimal hosts. */
  listFeatureRows?(): Array<{
    feature: string;
    enabled: boolean;
    settings?: Record<string, unknown> | undefined;
  }>;
}

export type AnyClient = QuickCreateClient;

/** True when the class node exists and is archived (the visibility flag). */
export function isArchivedClass(client: QuickCreateClient, classId: string): boolean {
  const node = client.getNodeRaw?.(classId);
  return node !== undefined && node.isActive === false;
}

/** Display label for a system class id ("book" → "Book"; "tv_series" → "TV Series"). */
export function systemClassLabel(classId: string): string {
  const entry = (Object.entries(SYSTEM_CLASS_UUIDS) as Array<[string, string]>).find(
    ([, uuid]) => uuid === classId,
  );
  if (entry === undefined) return "Node";
  return classLabelOf(entry[0]);
}

/** Human label for a system class name ("tv_series" → "TV Series"). */
function classLabelOf(name: string): string {
  if (name === "tv_series") return "TV Series";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The class's display name for the modal header: the class node's own
 * (title-is-content) display name when it carries one, the system manifest
 * label as fallback (unseeded classes, ad-hoc fixtures).
 */
export function classDisplayName(client: AnyClient, classId: string): string {
  const node = client.listClasses().find((cls) => cls.id === classId);
  if (node !== undefined) {
    const derived = displayNameOf(node);
    if (derived !== "") return derived;
  }
  return systemClassLabel(classId);
}

/**
 * Collect a class id plus all of its ancestors: the client's dynamic
 * extends edges first, with the static system extends map as fallback so
 * seeded subclasses resolve even before their class list has loaded.
 */
export function collectSelfAndAncestors(client: AnyClient, classId: string): Set<string> {
  const parentsByChild = new Map<string, string[]>();
  for (const cls of client.listClasses()) {
    if (cls.isClass) parentsByChild.set(cls.id, client.getClassParents(cls.id));
  }
  for (const [name, parents] of Object.entries(SYSTEM_CLASS_EXTENDS)) {
    const childId = SYSTEM_CLASS_UUIDS[name as keyof typeof SYSTEM_CLASS_UUIDS];
    if (!parentsByChild.has(childId)) {
      parentsByChild.set(
        childId,
        parents.map((parent) => SYSTEM_CLASS_UUIDS[parent as keyof typeof SYSTEM_CLASS_UUIDS]),
      );
    }
  }
  const lineage = new Set<string>();
  const stack = [classId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (lineage.has(current)) continue;
    lineage.add(current);
    for (const parent of parentsByChild.get(current) ?? []) stack.push(parent);
  }
  return lineage;
}

/** True when the class's lineage reaches the citation family base. */
export function isCitationFamilyClass(client: AnyClient, classId: string): boolean {
  return collectSelfAndAncestors(client, classId).has(SYSTEM_CLASS_UUIDS.source);
}

/**
 * The New-popup class-pick routing: EVERY class pick
 * opens the class-driven QuickCreateModal — the source family is no longer
 * special (the resolver's magic-wand door is the command palette's "Add
 * source…" row and the picker's paste-URL row). Two carve-outs:
 * - `asset` → the asset upload modal (uploading IS creating an asset);
 * - the bare `source` family base → its designed everyday default (`book`),
 *   the citation analogue of the retired superclass defaults.
 */
export type NewNodeRoute =
  | { kind: "quick-create"; classId: string }
  | { kind: "asset-upload"; classId: string }
  | { kind: "plain" };

export function routeNewNodeClass(client: AnyClient, classId: string): NewNodeRoute {
  const lineage = collectSelfAndAncestors(client, classId);
  if (lineage.has(SYSTEM_CLASS_UUIDS.asset)) {
    return { kind: "asset-upload", classId: SYSTEM_CLASS_UUIDS.asset };
  }
  if (classId === SYSTEM_CLASS_UUIDS.source) {
    return { kind: "quick-create", classId: SYSTEM_CLASS_UUIDS.book };
  }
  return { kind: "quick-create", classId };
}

/**
 * Split the modal's monoblock multi-text input into entries: ";" or NEWLINE
 * separates entries — a comma lives INSIDE a "Family, Given" name, so it
 * never splits (the 2026-10-24 ruling). Empty entries drop.
 */
export function splitAuthorList(text: string): string[] {
  return text
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// The staged properties form model
// ---------------------------------------------------------------------------

/**
 * One staged value — the modal-state shape the create form holds per bound
 * property. NOTHING touches the client until the Create flush: `text` is the
 * monoblock editor for text/url/email properties (multi schemas split on ";"
 * or newline at flush), `number` keeps its raw text and parses at flush,
 * `select` holds the chosen option ids (single-select keeps at most one),
 * `boolean` is tri-state (null = never touched, so an unchecked box writes
 * no op), and `date` holds a partial ISO ("1965" / "1965-03" / "1965-03-04")
 * resolved through the date chain at flush.
 */
export type StagedPropertyValue =
  | { kind: "text"; text: string }
  | { kind: "number"; text: string }
  | { kind: "select"; optionIds: string[] }
  | { kind: "boolean"; value: boolean | null }
  | { kind: "date"; text: string };

/** A bound property plus its schema row (the options live on the schema). */
export interface StagedPropertyBinding {
  binding: ClassBinding;
  /** The property-schema row; null when the schema is unseeded (fresh workspace). */
  schema: ClientPropertySchema | null;
}

/**
 * The types the staged form covers. `object` and `asset` values need a live
 * node's picker surfaces (and the CAS upload flow) — they are excluded from
 * the create modal and stay settable from the node's metadata panel; select
 * schemas without options have no honest control (nothing to pick) and are
 * excluded the same way. The `cover` property is header chrome everywhere
 * (the metadata panel suppresses it too), never a form row. Inactive
 * (soft-unbound) bindings never render.
 */
export function isStagedType(type: string, options: ClientPropertyOption[] | null): boolean {
  if (
    type === "text" ||
    type === "email" ||
    type === "number" ||
    type === "boolean" ||
    type === "datetime"
  ) {
    return true;
  }
  return (
    (type === "select" || type === "multi_select") &&
    options !== null &&
    options.length > 0
  );
}

/**
 * The picked class's staged-form rows: its bound properties (extends-aware,
 * ALPHABETICAL by property name — the read-time derivation law), filtered to
 * the staged types and active bindings. PURE READ — cancel leaves zero log
 * entries:
 * - Registry bindings (getClassBindings) come first.
 * - System classes additionally get a READ-SYNTHESIZED row per seed spec
 *   whose bindTo class sits in the lineage (getClassBindings' own seed
 *   fallback covers only the class's OWN specs; a book inherits source's
 *   bindings on a server-seeded workspace, and the synthesis mirrors that
 *   read for a fresh one). The pool's `bind: false` venue fields never
 *   synthesize — their visibility genuinely rides authored binding rows
 *   (the server seed's SYSTEM_SOURCE_CLASS_BINDINGS), or the prefill's
 *   carried rows (stagedPrefillRowsOf).
 * - The schemas the flush needs are authored at CREATE time by
 *   ensureCitationFamily (the write-time self-heal), never at mount.
 */
export function stagedBindingsOf(client: AnyClient, classId: string): StagedPropertyBinding[] {
  const schemas = client.listPropertySchemas();
  const schemaOf = (id: string): ClientPropertySchema | null =>
    schemas.find((schema) => schema.id === id) ?? null;
  const byId = new Map<string, StagedPropertyBinding>();
  const accept = (binding: ClassBinding): void => {
    if (binding.active === false) return;
    if (binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover) return;
    const schema = schemaOf(binding.propertySchemaId);
    if (!isStagedType(schema?.type ?? binding.type, schema?.options ?? null)) return;
    byId.set(binding.propertySchemaId, { binding, schema });
  };
  for (const binding of client.getClassBindings(classId)) accept(binding);

  const systemName = (Object.entries(SYSTEM_CLASS_UUIDS) as Array<[string, string]>).find(
    ([, id]) => id === classId,
  )?.[0] as SystemClassName | undefined;
  if (systemName !== undefined) {
    const lineage = collectSelfAndAncestors(client, classId);
    for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
      if (spec === undefined || spec.bindTo === undefined || spec.bind === false) continue;
      const bindClassId = SYSTEM_CLASS_UUIDS[spec.bindTo];
      if (!lineage.has(bindClassId)) continue;
      const id = SYSTEM_PROPERTY_UUIDS[name as keyof typeof SYSTEM_PROPERTY_UUIDS];
      if (byId.has(id)) continue;
      const schema = schemaOf(id);
      if (!isStagedType(schema?.type ?? spec.type, schema?.options ?? null)) continue;
      accept({
        propertySchemaId: id,
        name: SYSTEM_PROPERTY_DISPLAY_NAMES[name as keyof typeof SYSTEM_PROPERTY_DISPLAY_NAMES],
        type: spec.type,
        multi: spec.multi ?? false,
        targetClassFilter: null,
        datePrecision: null,
        dateQualified: null,
        active: true,
        pinned: spec.pinned ?? false,
      });
    }
  }
  return [...byId.values()].sort((a, b) =>
    stagedLabelOf(a).localeCompare(stagedLabelOf(b)),
  );
}

/**
 * The extra rows a resolver prefill carries: values for property schema ids
 * the class does not bind (the resolved venue fields on a fresh workspace).
 * Pure read-synthesis off the prefill + the seed specs — the flush-time
 * ensureCitationFamily authors the schemas + class-local bindings before the
 * property writes land.
 */
export function stagedPrefillRowsOf(
  client: AnyClient,
  prefill: { values: Record<string, string> },
  existing: ReadonlyArray<StagedPropertyBinding>,
): StagedPropertyBinding[] {
  const schemas = client.listPropertySchemas();
  const out: StagedPropertyBinding[] = [];
  for (const schemaId of Object.keys(prefill.values)) {
    if (existing.some((row) => row.binding.propertySchemaId === schemaId)) continue;
    const name = propertyNameOf(schemaId);
    const spec = name !== null ? SYSTEM_PROPERTY_SPECS[name] : undefined;
    const schema = schemas.find((candidate) => candidate.id === schemaId) ?? null;
    const type = schema?.type ?? spec?.type ?? "text";
    if (!isStagedType(type, schema?.options ?? null)) continue;
    out.push({
      binding: {
        propertySchemaId: schemaId,
        name:
          schema?.name ??
          (name !== null ? SYSTEM_PROPERTY_DISPLAY_NAMES[name] : undefined) ??
          schemaId,
        type,
        multi: schema?.multi ?? spec?.multi ?? false,
        targetClassFilter: null,
        datePrecision: null,
        dateQualified: null,
        active: true,
        pinned: spec?.pinned ?? false,
      },
      schema,
    });
  }
  return out;
}

/** The empty staged value for a row, by its schema type. */
export function initialStagedValue(row: StagedPropertyBinding): StagedPropertyValue {
  const type = row.schema?.type ?? row.binding.type;
  if (type === "boolean") return { kind: "boolean", value: null };
  if (type === "select" || type === "multi_select") return { kind: "select", optionIds: [] };
  if (type === "datetime") return { kind: "date", text: "" };
  if (type === "number") return { kind: "number", text: "" };
  return { kind: "text", text: "" };
}

/** The staged row's editor type (the schema row wins; the binding is the fallback). */
export function stagedTypeOf(row: StagedPropertyBinding): string {
  return row.schema?.type ?? row.binding.type;
}

/** The staged row's label — the schema row is the naming authority. */
export function stagedLabelOf(row: StagedPropertyBinding): string {
  const name = propertyNameOf(row.binding.propertySchemaId);
  return (
    row.schema?.name ??
    row.binding.name ??
    (name !== null ? SYSTEM_PROPERTY_DISPLAY_NAMES[name] : undefined) ??
    row.binding.propertySchemaId
  );
}

/** The staged value's text where the row is text/number/date-shaped ("" otherwise). */
export function stagedTextOf(value: StagedPropertyValue): string {
  return value.kind === "text" || value.kind === "number" || value.kind === "date"
    ? value.text
    : "";
}

/** Reverse lookup: a system property schema id → its seed spec name, when reserved. */
export function propertyNameOf(propertySchemaId: string): SystemPropertyName | null {
  const entry = (Object.entries(SYSTEM_PROPERTY_UUIDS) as Array<[string, string]>).find(
    ([, id]) => id === propertySchemaId,
  );
  return entry === undefined ? null : (entry[0] as SystemPropertyName);
}

/** A staged partial ISO date at the granularity the user typed. */
export interface StagedDate {
  /** The padded calendar day the chain ensure runs against. */
  iso: string;
  granularity: "year" | "month" | "day";
}

/**
 * Parse a staged date text: "1965" (year), "1965-03" (month), "1965-03-04"
 * (day). Anything else is null — the caller surfaces the honest error and
 * nothing writes. Month/day ranges validate.
 */
export function parseStagedDateText(text: string): StagedDate | null {
  const trimmed = text.trim();
  let match = /^(\d{4})$/.exec(trimmed);
  if (match !== null) return { iso: `${trimmed}-01-01`, granularity: "year" };
  match = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (match !== null) {
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    return { iso: `${trimmed}-01`, granularity: "month" };
  }
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match !== null) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { iso: trimmed, granularity: "day" };
  }
  return null;
}

/** A concrete, pre-resolved property write (the batch's element). */
export interface ConcretePropertyWrite {
  propertySchemaId: string;
  value: unknown;
  idx: number;
}

/**
 * Expand staged values into concrete writes — the ONLY place a staged shape
 * becomes wire values. Runs BEFORE the create batch: multi text splits into
 * one write per element, numbers parse (fail loud before anything writes),
 * dates resolve through the date chain (`{ nodeId }` at the typed
 * granularity — the publicationYear case lands the chain's year node, the
 * SCHEMA.md "Datetime" contract), and untouched tri-state booleans /
 * unselected options write nothing. A date or number that fails to validate
 * THROWS before any op exists — cancel-grade honesty: nothing half-creates.
 */
export async function expandStagedValues(
  client: AnyClient,
  entries: ReadonlyArray<{ row: StagedPropertyBinding; value: StagedPropertyValue }>,
): Promise<ConcretePropertyWrite[]> {
  const writes: ConcretePropertyWrite[] = [];
  for (const { row, value } of entries) {
    const propertySchemaId = row.binding.propertySchemaId;
    const multi = row.schema?.multi ?? row.binding.multi;
    if (value.kind === "text") {
      const trimmed = value.text.trim();
      if (trimmed === "") continue;
      if (multi) {
        splitAuthorList(trimmed).forEach((entry, index) => {
          writes.push({ propertySchemaId, value: entry, idx: index });
        });
      } else {
        writes.push({ propertySchemaId, value: trimmed, idx: 0 });
      }
    } else if (value.kind === "number") {
      const trimmed = value.text.trim();
      if (trimmed === "") continue;
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        throw new Error(`"${trimmed}" is not a number`);
      }
      writes.push({ propertySchemaId, value: parsed, idx: 0 });
    } else if (value.kind === "select") {
      if (value.optionIds.length === 0) continue;
      // Single-select writes the one chosen id; multi_select writes the id
      // array as one row value (the SelectPropertyRow write shape).
      writes.push({
        propertySchemaId,
        value: multi || value.optionIds.length !== 1 ? [...value.optionIds] : value.optionIds[0]!,
        idx: 0,
      });
    } else if (value.kind === "boolean") {
      if (value.value === null) continue;
      writes.push({ propertySchemaId, value: value.value, idx: 0 });
    } else {
      const trimmed = value.text.trim();
      if (trimmed === "") continue;
      const parsed = parseStagedDateText(trimmed);
      if (parsed === null) {
        throw new Error(`"${trimmed}" is not a date (use YYYY, YYYY-MM, or YYYY-MM-DD)`);
      }
      const chain = await client.ensureDateChain(parsed.iso);
      const nodeId =
        parsed.granularity === "year"
          ? chain.year
          : parsed.granularity === "month"
            ? chain.month
            : chain.day;
      writes.push({ propertySchemaId, value: { nodeId }, idx: 0 });
    }
  }
  return writes;
}

/** The create input for a classed node with its staged properties. */
export interface ClassedCreateInput {
  title: string;
  /** The class to assign (a system class, a subclass, or a user class). */
  classId: string;
  /** The staged rows + values, expanded at flush. */
  values: ReadonlyArray<{ row: StagedPropertyBinding; value: StagedPropertyValue }>;
  /** The resolved-PDF attach intent: uploaded to CAS and linked on the node. */
  attachPdf?: { file: Blob; filename: string } | null;
  /**
   * When the class is archived (the class-visibility flag): auto-enable it —
   * the un-archive rides the SAME undo batch as the create and the property
   * writes (client.beginClassedCreate).
   */
  unarchiveArchivedClass?: boolean;
}

/**
 * Create a properly classed node with the staged properties. The CAS upload
 * runs FIRST (a failed upload means no create at all, no half-node); the
 * staged values expand next (a failed date/number validation means no
 * create either); then the un-archive + create + every property write land
 * in ONE undo batch when the host carries the gesture (one undo restores
 * everything), with the plain createObject + writes as the minimal-host
 * fallback. Returns the new node id.
 */
export async function createClassedObject(
  client: AnyClient,
  input: ClassedCreateInput,
): Promise<string> {
  let asset: AssetUploadResult | null = null;
  if (input.attachPdf !== undefined && input.attachPdf !== null) {
    if (client.uploadAsset === undefined || client.attachAsset === undefined) {
      throw new Error("createClassedObject: this client cannot attach assets");
    }
    asset = await client.uploadAsset(input.attachPdf.file, input.attachPdf.filename);
  }
  const properties = await expandStagedValues(client, input.values);
  const unarchive =
    input.unarchiveArchivedClass === true && isArchivedClass(client, input.classId);
  const id =
    client.beginClassedCreate !== undefined
      ? await client.beginClassedCreate({
          classId: input.classId,
          title: input.title,
          unarchive,
          properties,
        })
      : await (async () => {
          const created = await client.createObject({
            isEmbedded: false,
            name: input.title,
            classIds: [input.classId],
          });
          for (const write of properties) {
            await client.setProperty(created, write.propertySchemaId, write.value, write.idx);
          }
          return created;
        })();
  if (asset !== null && client.attachAsset !== undefined) {
    await client.attachAsset(id, asset);
  }
  return id;
}

/**
 * Author the citation property schemas + class bindings the quick-create
 * writes need, when missing; a complete no-op once present (the
 * ensureTaskFamily idiom — fresh/offline workspaces self-heal; server-seeded
 * ones skip every branch). Authored at the reserved seed ids from
 * SYSTEM_PROPERTY_SPECS (the server seed authors the same rows, so a later
 * server seed converges by idempotence). `venueKeys` names the resolved
 * venue fields a prefill carries (pool property names) so a fresh workspace
 * self-heals those schemas too. `bindVenueToClassId` (the modal's flush-time
 * heal with a prefill) additionally authors the class-local binding rows for
 * the carried pool fields on the picked class — what the server seed does
 * per SYSTEM_SOURCE_CLASS_BINDINGS — so the property writes validate against
 * scoped schemas exactly like a server-seeded workspace's.
 */
export async function ensureCitationFamily(
  client: AnyClient,
  venueKeys: readonly string[] = [],
  bindVenueToClassId?: string,
): Promise<void> {
  const keys: SystemPropertyName[] = [
    "authors",
    "editors",
    "doi",
    "isbn",
    "publicationDate",
    "publisher",
    "url",
    "citekey",
    "givenName",
    "familyName",
    ...venueKeys.filter((key): key is SystemPropertyName => key in SYSTEM_PROPERTY_UUIDS),
  ];
  const have = new Set(client.listPropertySchemas().map((schema) => schema.id));
  // True when the class-local venue binding row is already authored (the
  // class.property.set upsert is idempotent, but a skipped no-op is quieter).
  const venueBound = (schemaId: string): boolean =>
    bindVenueToClassId !== undefined &&
    client.getClassBindings(bindVenueToClassId).some(
      (binding) => binding.propertySchemaId === schemaId,
    );
  for (const key of keys) {
    const id = SYSTEM_PROPERTY_UUIDS[key];
    const spec = SYSTEM_PROPERTY_SPECS[key];
    if (have.has(id)) {
      // A carried venue schema that exists but is not bound class-locally
      // yet (a base-only heal ran earlier) still gets the binding.
      if (
        bindVenueToClassId !== undefined &&
        spec?.bind === false &&
        venueKeys.includes(key) &&
        !venueBound(id)
      ) {
        await client.setClassProperty(bindVenueToClassId, id, {});
      }
      continue;
    }
    if (spec === undefined) continue;
    const bindTo = spec.bindTo !== undefined ? SYSTEM_CLASS_UUIDS[spec.bindTo] : undefined;
    await client.createPropertySchema({
      id,
      name: SYSTEM_PROPERTY_DISPLAY_NAMES[key],
      type: spec.type,
      ...(spec.multi === true ? { multi: true } : {}),
      // Scoped to the bound class (the sole locality authority) unless the seed declares the schema global (url is the
      // precedent — global schema, binding row on the family base).
      ...(spec.global === true || bindTo === undefined ? {} : { scopeClassIds: [bindTo] }),
      ...(spec.targetClassFilter !== undefined
        ? {
            targetClassFilter: spec.targetClassFilter.map(
              (name) => SYSTEM_CLASS_UUIDS[name as keyof typeof SYSTEM_CLASS_UUIDS],
            ),
          }
        : {}),
    });
    if (
      bindVenueToClassId !== undefined &&
      spec.bind === false &&
      venueKeys.includes(key) &&
      !venueBound(id)
    ) {
      // A carried venue field binds class-locally (the pool's bind: false
      // contract — visibility rides the picked class, not the family base).
      await client.setClassProperty(bindVenueToClassId, id, {});
    } else if (bindTo !== undefined && spec.bind !== false) {
      await client.setClassProperty(bindTo, id, {});
    }
  }
}

/**
 * The citation draft read off the staged rows: the staged DOI/ISBN and the
 * effective citekey — the typed value when present, otherwise the
 * auto-citekey generation when the setting is on (empty stays empty: no
 * data for the pattern tokens is not an error). The duplicate warning and
 * the flush share this, so what warns is exactly what would write.
 */
export function citationDraftOf(
  client: AnyClient,
  entries: ReadonlyArray<{ row: StagedPropertyBinding; value: StagedPropertyValue }>,
  title: string,
): { doi: string; isbn: string; citekey: string } {
  const textOf = (name: SystemPropertyName): string => {
    const entry = entries.find(
      (candidate) => candidate.row.binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS[name],
    );
    return entry === undefined ? "" : stagedTextOf(entry.value);
  };
  const trimmedCitekey = textOf("citekey").trim();
  const settings = readSourceSettings(client);
  const stagedDate = parseStagedDateText(textOf("publicationDate"));
  const citekeyValue =
    trimmedCitekey !== ""
      ? trimmedCitekey
      : settings.autoCitekey
        ? generateCitekey(
            settings.citekeyPattern,
            {
              authors: splitAuthorList(textOf("authors")),
              year: stagedDate === null ? null : Number(stagedDate.iso.slice(0, 4)),
              title,
            },
            existingCitekeys(client),
          )
        : "";
  return { doi: textOf("doi").trim(), isbn: textOf("isbn").trim(), citekey: citekeyValue };
}

/**
 * The seed property names a prefill carries (the ensureCitationFamily venue
 * self-heal input) — the prefill is keyed by schema id; reverse-map the
 * reserved system ids to their spec names.
 */
export function venueKeysOfPrefill(prefill: { values: Record<string, string> }): string[] {
  return Object.keys(prefill.values)
    .map((id) => propertyNameOf(id))
    .filter((name): name is SystemPropertyName => name !== null);
}

/**
 * The citekeys of every LIVE source in the workspace (the collision scan's
 * input): the `citekey` text values over the extends-aware, active-only
 * family-members read. Empty/absent on hosts without the effective read.
 */
export function existingCitekeys(client: AnyClient): string[] {
  if (client.getEffectiveProperties === undefined) return [];
  const out: string[] = [];
  for (const node of client.getClassMembers(SYSTEM_CLASS_UUIDS.source)) {
    for (const row of client.getEffectiveProperties(node.id)) {
      if (row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey && typeof row.value === "string") {
        const trimmed = row.value.trim();
        if (trimmed !== "") out.push(trimmed);
      }
    }
  }
  return out;
}

/** The citekey/resolver-surface snapshot of the sources feature settings. */
export interface SourceSettingsSnapshot {
  autoCitekey: boolean;
  citekeyPattern: string | undefined;
  /**
   * The resolver gate read (the add-source dialog): an absent row or absent
   * key is the server default ON — only an explicit `false` disables.
   */
  resolverEnabled: boolean;
}

/**
 * The sources feature row read (task-5 settings write the same row): an
 * absent row or absent key is the server default — auto-citekey OFF (opt
 * in), the pattern undefined (the default pattern renders instead), the
 * resolver ON (the egress gate, only an explicit false disables).
 */
export function readSourceSettings(client: AnyClient): SourceSettingsSnapshot {
  const rows = client.listFeatureRows?.() ?? [];
  const settings = rows.find((row) => row.feature === "sources")?.settings ?? {};
  return {
    autoCitekey: settings.autoCitekey === true,
    citekeyPattern: typeof settings.citekeyPattern === "string" ? settings.citekeyPattern : undefined,
    resolverEnabled: settings.resolverEnabled !== false,
  };
}

/**
 * The deterministic collision suffix: 0 → "a", 25 → "z", 26 → "aa", … */
function collisionSuffix(index: number): string {
  let n = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return suffix;
}

/**
 * Auto-citekey generation: render the settings pattern from
 * the entry (first author's family + year + title), then disambiguate
 * against the live citekeys CASE-INSENSITIVELY — the first free a/b/c…
 * suffix appends deterministically ("key", "keya", "keyb", …). An absent or
 * UNCOMPILABLE pattern falls back to the workspace default; a valid pattern
 * that renders EMPTY stays empty (the caller skips the write — no data for
 * the tokens is not an error). A still-uncompilable default renders the
 * empty string, never throws — the settings UI refuses invalid patterns at
 * write time.
 */
export function generateCitekey(
  pattern: string | undefined,
  entry: CitekeyEntry,
  existing: readonly string[],
): string {
  const taken = new Set(existing.map((key) => key.trim().toLowerCase()).filter(Boolean));
  // renderCitekeyPattern returns null ONLY when the pattern does not compile
  // — an empty render is a legitimate answer and must not trigger the
  // default-pattern fallback.
  const stored = pattern !== undefined ? renderCitekeyPattern(pattern, entry) : null;
  const base = stored ?? renderCitekeyPattern(DEFAULT_CITEKEY_PATTERN, entry) ?? "";
  if (base === "" || !taken.has(base.toLowerCase())) return base;
  for (let index = 0; ; index++) {
    const candidate = `${base}${collisionSuffix(index)}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The duplicate-warning scan: the LIVE source node already carrying the
 * given DOI (case-insensitive), ISBN (digit/X-normalized), or CITEKEY
 * (case-insensitive) — any of the three, first hit wins. The modal surfaces
 * it ("Already in your library") — the create stays allowed, the warning is
 * honest. Absent on hosts without the effective read. (The citekey coverage
 * is the 2026-10-26 owner addition — a manually typed citekey that collides
 * warns the same way a duplicate DOI does; auto-generated citekeys already
 * carry the collision suffix, so the warning fires for manual values.)
 */
export function findSourceByIdentifier(
  client: AnyClient,
  identifier: {
    doi?: string | undefined;
    isbn?: string | undefined;
    citekey?: string | undefined;
  },
): ClientNode | null {
  if (client.getEffectiveProperties === undefined) return null;
  const doi = identifier.doi?.trim().toLowerCase();
  const isbn = identifier.isbn?.trim().replace(/[^0-9x]/gi, "").toUpperCase();
  const citekey = identifier.citekey?.trim().toLowerCase();
  if ((doi ?? "") === "" && (isbn ?? "") === "" && (citekey ?? "") === "") return null;
  for (const node of client.getClassMembers(SYSTEM_CLASS_UUIDS.source)) {
    for (const row of client.getEffectiveProperties(node.id)) {
      if (typeof row.value !== "string") continue;
      const value = row.value.trim();
      if (value === "") continue;
      if (
        doi !== undefined &&
        doi !== "" &&
        row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.doi &&
        value.toLowerCase() === doi
      ) {
        return node;
      }
      if (
        isbn !== undefined &&
        isbn !== "" &&
        row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.isbn &&
        value.replace(/[^0-9x]/gi, "").toUpperCase() === isbn
      ) {
        return node;
      }
      if (
        citekey !== undefined &&
        citekey !== "" &&
        row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey &&
        value.toLowerCase() === citekey
      ) {
        return node;
      }
    }
  }
  return null;
}

/**
 * The exact-title duplicate scan: a LIVE member of the
 * class whose flattened title (title-is-content — the content stringified to
 * text, the displayNameOf derivation) equals the staged title EXACTLY after
 * whitespace trimming (case-sensitive), if any. The modal surfaces it like
 * the identifier duplicates — the create stays allowed, the warning is
 * honest. Extends-aware, active-only via the same member read the citekey
 * scan uses.
 */
export function findClassMemberByTitle(
  client: AnyClient,
  classId: string,
  title: string,
): ClientNode | null {
  const trimmed = title.trim();
  if (trimmed === "") return null;
  for (const node of client.getClassMembers(classId)) {
    if (displayNameOf(node) === trimmed) return node;
  }
  return null;
}

/** The created node's display name (modal result toasts). */
export function displayNameOf(node: ClientNode | undefined): string {
  return node === undefined ? "" : titleOfNode(node);
}
