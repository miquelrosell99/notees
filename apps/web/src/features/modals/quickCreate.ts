/**
 * Quick-create — the class-aware "create" resolution + creators behind the
 * quick-create row (Quick-create modals: Source: type/title/authors/editors/
 * year/DOI/ISBN/URL/publisher/citekey + the resolved venue fields; Agent:
 * given/family split). Ported from the archived classAwareCreate.ts: when a
 * node picker's create row runs under a class filter of the source family
 * or the agent family, creating opens the QuickCreateModal with the
 * citation fields up front instead of silently creating a plain page.
 * Title-is-content: the title is the node's initial text content.
 *
 * REWIRED 2026-10-24 (source-library slice 3 task 6): the authors field
 * writes PLAIN `authors` TEXT values — "Family, Given" strings, split on
 * ";" or newline (a comma lives INSIDE a name), one element each, NO person
 * find-or-create (the 2026-10-23 owner ruling retyped `authors` to text;
 * the node-typed track is the separate `linkedAuthors` property, never
 * written here). The type list FILTERS archived type-classes (the
 * class-visibility flag); a resolved archived class is auto-enabled at
 * create time — the un-archive rides the SAME undo batch as the create
 * (client.beginSourceCreate). Auto-citekey renders the settings pattern
 * with a deterministic a/b/c collision suffix; a doi/isbn that already
 * exists on a live source surfaces the duplicate warning.
 *
 * The module is client-agnostic (composes only the shared client surface)
 * so it runs under both WorkspaceClient and WorkerClient, and unit-tests
 * pure.
 */

import {
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  deriveDisplayName,
  type SystemPropertyName,
} from "@notees/domain";

import type {
  AssetUploadResult,
  ClientNode,
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
 * The structural client surface the quick-create resolution + creators
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
  /** The effective property read (duplicate DOI + citekey collision scans). */
  getEffectiveProperties?(id: string): Array<{
    propertySchemaId: string;
    value: unknown;
  }>;
  /** The batched source-create gesture (un-archive + create, ONE undo entry). */
  beginSourceCreate?(input: {
    classId: string;
    title: string;
    unarchive: boolean;
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

export type QuickCreateKind = "source" | "agent";

export interface QuickCreatePlan {
  kind: QuickCreateKind;
  /**
   * Class to preselect in the modal: the filtered subclass when the filter
   * unambiguously identifies one (e.g. `book`), a sensible default for
   * superclass filters (`book` for `source`, `person` for `agent`).
   */
  defaultClassId: string;
}

/** The source subclasses in canonical seed order (SelectionButton options). */
export const SOURCE_SUBCLASS_IDS: string[] = (
  Object.entries(SYSTEM_CLASS_EXTENDS) as Array<[string, string[]]>
)
  .filter(([, parents]) => parents.includes("source"))
  .map(([name]) => SYSTEM_CLASS_UUIDS[name as keyof typeof SYSTEM_CLASS_UUIDS]);

/** Selector options for the source type picker (seed icons, the Icon resolver format). */
export function sourceSubclassOptions(): Array<{ value: string; label: string; icon: string }> {
  return SOURCE_SUBCLASS_IDS.map((id) => {
    const name = (Object.entries(SYSTEM_CLASS_UUIDS) as Array<[string, string]>).find(
      ([, uuid]) => uuid === id,
    )![0];
    const icon = SYSTEM_CLASS_ICONS[name as keyof typeof SYSTEM_CLASS_ICONS];
    return {
      value: id,
      label: classLabelOf(name),
      icon: icon ?? "mdiFileOutline",
    };
  });
}

/**
 * The type-list source for the modal (owner ruling, Review N1): archived
 * type-classes (`active = false`, the class-visibility flag) DON'T appear.
 * A class with no row in the store yet (unseeded fresh/offline workspace)
 * cannot be archived — it stays listed.
 */
export function activeSourceSubclassOptions(
  client: QuickCreateClient,
): Array<{ value: string; label: string; icon: string }> {
  return sourceSubclassOptions().filter((option) => {
    const node = client.getNodeRaw?.(option.value);
    return node === undefined || node.isActive !== false;
  });
}

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
  if (entry === undefined) return "Source";
  return classLabelOf(entry[0]);
}

/** Human label for a system class name ("tv_series" → "TV Series"). */
function classLabelOf(name: string): string {
  if (name === "tv_series") return "TV Series";
  return name.charAt(0).toUpperCase() + name.slice(1);
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

/**
 * Resolve how the picker's create row should behave under the given class
 * filters. Returns null when no class-aware flow applies (plain create).
 * The original resolution order preserved: asset first would upload; here only the
 * quick-create families are handled — everything else falls through.
 */
export function resolveQuickCreate(client: AnyClient, classFilters: string[]): QuickCreatePlan | null {
  for (const filterId of classFilters) {
    const lineage = collectSelfAndAncestors(client, filterId);
    if (lineage.has(SYSTEM_CLASS_UUIDS.source)) {
      return {
        kind: "source",
        defaultClassId: filterId === SYSTEM_CLASS_UUIDS.source ? SYSTEM_CLASS_UUIDS.book : filterId,
      };
    }
    if (lineage.has(SYSTEM_CLASS_UUIDS.agent)) {
      return {
        kind: "agent",
        defaultClassId:
          filterId === SYSTEM_CLASS_UUIDS.organization
            ? SYSTEM_CLASS_UUIDS.organization
            : SYSTEM_CLASS_UUIDS.person,
      };
    }
  }
  return null;
}

/**
 * Split a free-typed person name into given/family parts. The last word is
 * the family name; a single word is treated as the family name (the Zotero
 * single-field convention), keeping agent quick-create usable.
 */
export function splitPersonName(name: string): { givenName: string; familyName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { givenName: "", familyName: "" };
  if (parts.length === 1) return { givenName: "", familyName: parts[0]! };
  return { givenName: parts.slice(0, -1).join(" "), familyName: parts[parts.length - 1]! };
}

/**
 * Split the modal's monoblock authors input into entries: ";" or NEWLINE
 * separates authors — a comma lives INSIDE a "Family, Given" name, so it
 * never splits (the 2026-10-24 ruling). Empty entries drop.
 */
export function splitAuthorList(text: string): string[] {
  return text
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Author the citation property schemas + class bindings the quick-create
 * writes need, when missing; a complete no-op once present (the
 * ensureTaskFamily idiom — fresh/offline workspaces self-heal; server-seeded
 * ones skip every branch). Authored at the reserved seed ids from
 * SYSTEM_PROPERTY_SPECS (the server seed authors the same rows, so a later
 * server seed converges by idempotence). `venueKeys` names the resolved
 * venue fields a prefill carries (pool property names) so a fresh workspace
 * self-heals those schemas too.
 */
export async function ensureCitationFamily(
  client: AnyClient,
  venueKeys: readonly string[] = [],
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
  for (const key of keys) {
    const id = SYSTEM_PROPERTY_UUIDS[key];
    if (have.has(id)) continue;
    const spec = SYSTEM_PROPERTY_SPECS[key];
    if (spec === undefined) continue;
    const bindTo = spec.bindTo !== undefined ? SYSTEM_CLASS_UUIDS[spec.bindTo] : undefined;
    await client.createPropertySchema({
      id,
      name: SYSTEM_PROPERTY_DISPLAY_NAMES[key],
      type: spec.type,
      ...(spec.multi === true ? { multi: true } : {}),
      // Scoped to the bound class (the sole locality authority, owner ruling
      // 2026-10-20) unless the seed declares the schema global (url is the
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
    if (bindTo !== undefined) {
      await client.setClassProperty(bindTo, id, {});
    }
  }
}

/** The create input for a classed source with its bibliographic properties. */
export interface SourceCreateInput {
  title: string;
  /** Source class to assign (source itself or a subclass such as book). */
  classId: string;
  /** Plain "Family, Given" author strings — become `authors` TEXT elements. */
  authors?: string[];
  /** Plain "Family, Given" editor strings — become `editors` TEXT elements. */
  editors?: string[];
  doi?: string;
  isbn?: string;
  url?: string;
  publisher?: string;
  citekey?: string;
  /** Optional 4-digit publication year — links the year page. */
  publicationYear?: number | null;
  /** The resolved venue fields (pool property name → value), prefill-only. */
  venueFields?: Record<string, string>;
  /** The resolved-PDF attach intent: uploaded to CAS and linked on the node. */
  attachPdf?: { file: Blob; filename: string } | null;
  /**
   * When the class is archived (a resolved type the user archived in the
   * class-visibility list): auto-enable it — the un-archive rides the SAME
   * undo batch as the create (client.beginSourceCreate).
   */
  unarchiveArchivedClass?: boolean;
}

/**
 * Create a properly classed source node with the bibliographic properties
 * that were provided. The create itself (plus the optional archived-class
 * un-archive) goes through client.beginSourceCreate when the host carries
 * it, so one undo restores both; the property writes follow through the
 * normal surface. Returns the new node id.
 */
export async function createSourceObject(
  client: AnyClient,
  input: SourceCreateInput,
): Promise<string> {
  // The CAS upload runs FIRST: a failed upload means no create at all
  // (no half-source), and the attach itself is a normal write afterwards.
  let asset: AssetUploadResult | null = null;
  if (input.attachPdf !== undefined && input.attachPdf !== null) {
    if (client.uploadAsset === undefined || client.attachAsset === undefined) {
      throw new Error("createSourceObject: this client cannot attach assets");
    }
    asset = await client.uploadAsset(input.attachPdf.file, input.attachPdf.filename);
  }
  const unarchive =
    input.unarchiveArchivedClass === true && isArchivedClass(client, input.classId);
  const id =
    client.beginSourceCreate !== undefined
      ? await client.beginSourceCreate({
          classId: input.classId,
          title: input.title,
          unarchive,
        })
      : await client.createObject({
          isEmbedded: false,
          name: input.title,
          classIds: [input.classId],
        });
  await writeSourceProperties(client, id, input);
  if (asset !== null && client.attachAsset !== undefined) {
    await client.attachAsset(id, asset);
  }
  return id;
}

/** The bibliographic property writes behind createSourceObject. */
async function writeSourceProperties(
  client: AnyClient,
  id: string,
  input: SourceCreateInput,
): Promise<void> {
  const authors = (input.authors ?? []).map((name) => name.trim()).filter(Boolean);
  for (let index = 0; index < authors.length; index++) {
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.authors, authors[index]!, index);
  }
  const editors = (input.editors ?? []).map((name) => name.trim()).filter(Boolean);
  for (let index = 0; index < editors.length; index++) {
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.editors, editors[index]!, index);
  }
  const scalars: Array<[SystemPropertyName, string | undefined]> = [
    ["doi", input.doi],
    ["isbn", input.isbn],
    ["url", input.url],
    ["publisher", input.publisher],
    ["citekey", input.citekey],
  ];
  for (const [key, value] of scalars) {
    const trimmed = value?.trim();
    if (trimmed) {
      await client.setProperty(id, SYSTEM_PROPERTY_UUIDS[key], trimmed, 0);
    }
  }
  if (input.publicationYear != null && Number.isInteger(input.publicationYear)) {
    // The datetime property links the chain's year node (SCHEMA.md "Datetime").
    const { year } = await client.ensureDateChain(`${input.publicationYear}-01-01`);
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.publicationDate, { nodeId: year }, 0);
  }
  for (const [key, value] of Object.entries(input.venueFields ?? {})) {
    const trimmed = value.trim();
    if (trimmed === "" || !(key in SYSTEM_PROPERTY_UUIDS)) continue;
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS[key as SystemPropertyName], trimmed, 0);
  }
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
 * Auto-citekey generation (owner ruling): render the settings pattern from
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
 * given DOI (case-insensitive) or ISBN (digit/X-normalized), if any. The
 * modal surfaces it ("Already in your library") — the create stays allowed,
 * the warning is honest. Absent on hosts without the effective read.
 */
export function findSourceByIdentifier(
  client: AnyClient,
  identifier: { doi?: string | undefined; isbn?: string | undefined },
): ClientNode | null {
  if (client.getEffectiveProperties === undefined) return null;
  const doi = identifier.doi?.trim().toLowerCase();
  const isbn = identifier.isbn?.trim().replace(/[^0-9x]/gi, "").toUpperCase();
  if ((doi ?? "") === "" && (isbn ?? "") === "") return null;
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
    }
  }
  return null;
}

export interface AgentCreateInput {
  agentType: "person" | "organization";
  /** Organization display name (ignored for persons). */
  name?: string;
  /** Person given name (ignored for organizations). */
  givenName?: string;
  /** Person family name (ignored for organizations). */
  familyName?: string;
}

/**
 * Create a minimal agent node: persons carry given/family name (their
 * display name is the full natural name); organizations carry just a name.
 * Deliberately not a contact manager. Returns the new node id.
 */
export async function createAgentObject(
  client: AnyClient,
  input: AgentCreateInput,
): Promise<string> {
  const isPerson = input.agentType === "person";
  const displayName = isPerson
    ? [input.givenName?.trim(), input.familyName?.trim()].filter(Boolean).join(" ")
    : (input.name ?? "").trim();
  if (displayName === "") throw new Error("Agent name is required");
  const classId =
    input.agentType === "person" ? SYSTEM_CLASS_UUIDS.person : SYSTEM_CLASS_UUIDS.organization;
  const id = await client.createObject({ isEmbedded: false, name: displayName, classIds: [classId] });
  if (isPerson) {
    const givenName = input.givenName?.trim();
    const familyName = input.familyName?.trim();
    if (givenName) {
      await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.givenName, givenName, 0);
    }
    if (familyName) {
      await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.familyName, familyName, 0);
    }
  }
  return id;
}

/** The created node's display name (modal result toasts). */
export function displayNameOf(node: ClientNode | undefined): string {
  return node === undefined ? "" : (deriveDisplayName(node) ?? "");
}
