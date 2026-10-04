/**
 * Quick-create — the class-aware "create" resolution + creators behind the
 * §34.19 :1172 row (Quick-create modals: Source: authors/year/DOI; Agent:
 * given/family split). Ported from v1's classAwareCreate.ts (Decision 17–19
 * there): when a node picker's create row runs under a class filter of the
 * source family or the agent family, creating opens the QuickCreateModal
 * with the citation fields up front instead of silently creating a plain
 * page. Title-is-content: the title is the node's initial text content.
 *
 * The module is client-agnostic (composes only the shared client surface)
 * so it runs under both WorkspaceClient and WorkerClient, and unit-tests
 * pure.
 */

import {
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
  deriveDisplayName,
} from "@notees/domain";

import type {
  ClientNode,
  ClientPropertySchema,
  CreateObjectInput,
  CreatePropertySchemaInput,
  SetClassPropertyInput,
} from "@/core/workspace-client.js";

/**
 * The structural client surface the quick-create resolution + creators
 * compose. Satisfied by WorkspaceClient and the WorkerClient proxy (both
 * full surfaces); the node picker extends its own minimal client interface
 * from this so the modal can mount inside the picker with no casts.
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
 * v1's resolution order preserved: asset first would upload; here only the
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
 * single-field convention), keeping citekey generation usable.
 */
export function splitPersonName(name: string): { givenName: string; familyName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { givenName: "", familyName: "" };
  if (parts.length === 1) return { givenName: "", familyName: parts[0]! };
  return { givenName: parts.slice(0, -1).join(" "), familyName: parts[parts.length - 1]! };
}

/**
 * Author the citation property schemas + class bindings the quick-create
 * writes need, when missing; a complete no-op once present (the
 * ensureTaskFamily idiom — fresh/offline workspaces self-heal; server-seeded
 * ones skip every branch). Authored at the reserved seed ids, so a later
 * server seed converges by idempotence.
 */
export async function ensureCitationFamily(client: AnyClient): Promise<void> {
  const specs: Array<{
    id: string;
    name: string;
    type: "text" | "date" | "object";
    multi?: boolean;
    targetClassFilter?: string[];
    bindTo: string;
  }> = [
    {
      id: SYSTEM_PROPERTY_UUIDS.authors,
      name: "authors",
      type: "object",
      multi: true,
      targetClassFilter: [SYSTEM_CLASS_UUIDS.agent],
      bindTo: SYSTEM_CLASS_UUIDS.source,
    },
    { id: SYSTEM_PROPERTY_UUIDS.doi, name: "doi", type: "text", bindTo: SYSTEM_CLASS_UUIDS.source },
    {
      id: SYSTEM_PROPERTY_UUIDS.publicationDate,
      name: "publicationDate",
      type: "date",
      bindTo: SYSTEM_CLASS_UUIDS.source,
    },
    {
      id: SYSTEM_PROPERTY_UUIDS.givenName,
      name: "givenName",
      type: "text",
      bindTo: SYSTEM_CLASS_UUIDS.person,
    },
    {
      id: SYSTEM_PROPERTY_UUIDS.familyName,
      name: "familyName",
      type: "text",
      bindTo: SYSTEM_CLASS_UUIDS.person,
    },
  ];
  const have = new Set(client.listPropertySchemas().map((schema) => schema.id));
  for (const spec of specs) {
    if (have.has(spec.id)) continue;
    await client.createPropertySchema({
      id: spec.id,
      name: spec.name,
      type: spec.type,
      scope: "class",
      ...(spec.multi !== undefined ? { multi: spec.multi } : {}),
      ...(spec.targetClassFilter !== undefined ? { targetClassFilter: spec.targetClassFilter } : {}),
    });
    await client.setClassProperty(spec.bindTo, spec.id, { sequence: 0 });
  }
}

/** Find-or-create a person node by full natural name (case-insensitive). */
async function ensurePerson(client: AnyClient, fullName: string): Promise<string> {
  const wanted = fullName.trim().toLowerCase();
  const existing = client
    .getClassMembers(SYSTEM_CLASS_UUIDS.person)
    .find((node) => (deriveDisplayName(node) ?? "").trim().toLowerCase() === wanted);
  if (existing !== undefined) return existing.id;
  const { givenName, familyName } = splitPersonName(fullName);
  return createAgentObject(client, { agentType: "person", givenName, familyName });
}

export interface SourceCreateInput {
  title: string;
  /** Source class to assign (source itself or a subclass such as book). */
  classId: string;
  /** Free-typed author names — become/reuse linked person nodes, in order. */
  authors?: string[];
  doi?: string;
  /** Optional 4-digit publication year — links the year page. */
  publicationYear?: number | null;
}

/**
 * Create a properly classed source node with the bibliographic properties
 * that were provided. Returns the new node id.
 */
export async function createSourceObject(
  client: AnyClient,
  input: SourceCreateInput,
): Promise<string> {
  const id = await client.createObject({
    presentAsMain: true,
    name: input.title,
    classIds: [input.classId],
  });
  const authors = (input.authors ?? []).map((name) => name.trim()).filter(Boolean);
  if (authors.length > 0) {
    for (let index = 0; index < authors.length; index++) {
      const personId = await ensurePerson(client, authors[index]!);
      await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.authors, { nodeId: personId }, index);
    }
  }
  const doi = input.doi?.trim();
  if (doi) {
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.doi, doi, 0);
  }
  if (input.publicationYear != null && Number.isInteger(input.publicationYear)) {
    // The date-typed property links the chain's year node (SCHEMA.md "Dates").
    const { year } = await client.ensureDateChain(`${input.publicationYear}-01-01`);
    await client.setProperty(id, SYSTEM_PROPERTY_UUIDS.publicationDate, { nodeId: year }, 0);
  }
  return id;
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
 * Create a minimal agent node: persons carry given/family name (feeding
 * citekey generation) and their display name is the full natural name;
 * organizations carry just a name. Deliberately not a contact manager
 * (v1 Decision 19). Returns the new node id.
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
  const id = await client.createObject({ presentAsMain: true, name: displayName, classIds: [classId] });
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
