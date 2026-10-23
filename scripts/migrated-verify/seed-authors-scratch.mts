/**
 * Authors-to-text migration — SCRATCH seed harness (dev only, the task-8
 * verification companion of scripts/migrate-authors-to-text.mts).
 *
 * Builds a throwaway relay data dir that looks like a LIVE PRE-MIGRATION
 * workspace — the drifted state the authors migration exists to heal:
 *
 *  - the `authors` schema (…0012) still typed OBJECT (multi, source-scoped,
 *    agent-filtered — the pre-retype pool shape) while the branch SPEC
 *    retyped it to text-multi; `linkedAuthors` (…0006-…0001) already seeded
 *    object-multi→agent (the pool reached this workspace);
 *  - source-classed nodes carrying `authors` OBJECT {nodeId} values: PG5
 *    element adds (writer-minted element ids, one carrying metadata), legacy
 *    positional adds (deterministic row ids), a ref to an ARCHIVED agent
 *    (row exists — its name properties still drive the rewrite), and a ref
 *    to a DELETED agent (the broken-ref keep-value corner: the element rides
 *    untouched, reported);
 *  - a PARTIALLY-converged corner: S1 already carries a linkedAuthors
 *    element for agentA — the copy must add ONLY the missing refs;
 *  - a saved query view authored BEFORE the migration: a property condition
 *    on …0012 (`contains "Lovelace"`) plus a class-condition control — the
 *    dry run's meaning-flip enumeration must list the first, not the second;
 *  - agent name corners: full family+given ("Lovelace, Ada"), a no-name
 *    agent (title fallback), a given-name-only agent (single-part format).
 *
 * Plus two probe workspaces: one already converged (authors text-multi with
 * string values + linkedAuthors populated — a second migration run plans
 * NOTHING there) and one empty (no authors schema at all — nothing to do).
 *
 * NEVER point this at a real data dir: it WIPES the dir first — and it
 * HARD-REFUSES any --data-dir not under /tmp (fail loud, don't wipe).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrated-verify/seed-authors-scratch.mts \
 *     [--data-dir /tmp/notees-authors-scratch]
 */

import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { newEnvelope, type Envelope } from "../../packages/protocol/src/index.ts";
import {
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from "../../packages/domain/src/index.ts";

import { RelayStorage } from "../../apps/server/src/relay-storage.ts";

const DEVICE = "authors-scratch-seed";
const CLIENT = "authors-scratch-seed";
const ACTOR = "01920000-0000-7000-8000-0000000000f8";

/** The happy-path workspace: object-typed authors, all the value corners. */
export const WORKSPACE_MAIN = "4b7d1a00-1111-4000-8000-000000000001";
/** The converged probe: authors already text-multi — a re-run plans nothing. */
export const WORKSPACE_CONVERGED = "4b7d1a00-1111-4000-8000-000000000002";
/** The empty probe: no authors schema, no values — nothing to do. */
export const WORKSPACE_EMPTY = "4b7d1a00-1111-4000-8000-000000000003";

const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
const AGENT_ID = SYSTEM_CLASS_UUIDS.agent;
const PERSON_ID = SYSTEM_CLASS_UUIDS.person;

const AUTHORS_ID = SYSTEM_PROPERTY_UUIDS.authors;
const LINKED_AUTHORS_ID = SYSTEM_PROPERTY_UUIDS.linkedAuthors;
const GIVEN_NAME_ID = SYSTEM_PROPERTY_UUIDS.givenName;
const FAMILY_NAME_ID = SYSTEM_PROPERTY_UUIDS.familyName;

// Agent nodes (the people-graph targets).
export const AGENT_A = "51000000-0000-4000-8000-000000000001"; // person, full names
export const AGENT_B = "51000000-0000-4000-8000-000000000002"; // agent, title only
export const AGENT_C = "51000000-0000-4000-8000-000000000003"; // person, given name only
export const AGENT_D = "51000000-0000-4000-8000-000000000004"; // person, archived
export const AGENT_E = "51000000-0000-4000-8000-000000000005"; // person, deleted (broken ref)

// Source nodes (the carriers).
export const SOURCE_S1 = "52000000-0000-4000-8000-000000000001"; // PG5 elements + partial linkedAuthors
export const SOURCE_S2 = "52000000-0000-4000-8000-000000000002"; // legacy positional adds
export const SOURCE_S3 = "52000000-0000-4000-8000-000000000003"; // bound but empty

export const QUERIES_PAGE = "53000000-0000-4000-8000-000000000001";

// PG5 element ids for the S1 authors elements (+ the pre-existing linked one).
const EL_A = "61000000-0000-4000-8000-000000000001";
const EL_B = "61000000-0000-4000-8000-000000000002";
const EL_E = "61000000-0000-4000-8000-000000000003";
const EL_LINKED_A = "61000000-0000-4000-8000-000000000010";

export function buildSeedEnvelopes(): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  const push = (
    workspaceId: string,
    opType: string,
    payload: Record<string, unknown>,
    affected: string[],
  ): void => {
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: envelopes.length },
        affectedNodeIds: affected,
        opType,
        payload,
      }),
    );
  };
  const classCreate = (workspaceId: string, classId: string, name: keyof typeof SYSTEM_CLASS_DISPLAY_NAMES): void => {
    push(
      workspaceId,
      "class.create",
      {
        classId,
        contentAst: [{ type: "text", text: SYSTEM_CLASS_DISPLAY_NAMES[name] }],
        icon: SYSTEM_CLASS_ICONS[name],
      },
      [classId],
    );
    const parents = (SYSTEM_CLASS_EXTENDS[name] ?? []).map((parent) => SYSTEM_CLASS_UUIDS[parent]);
    if (parents.length > 0) {
      push(workspaceId, "class.setExtends", { classId, parentClassIds: parents }, [classId]);
    }
  };
  const objectCreate = (
    workspaceId: string,
    objectId: string,
    classIds: string[],
    title: string,
  ): void => {
    push(
      workspaceId,
      "object.create",
      { objectId, classIds, contentAst: [{ type: "text", text: title }] },
      [objectId],
    );
  };
  const nameSet = (workspaceId: string, objectId: string, schemaId: string, value: string): void => {
    push(workspaceId, "property.set", { objectId, propertySchemaId: schemaId, value }, [objectId]);
  };

  // --- Workspace 1: the happy path -------------------------------------------
  const ws = WORKSPACE_MAIN;
  classCreate(ws, SOURCE_ID, "source");
  classCreate(ws, AGENT_ID, "agent");
  classCreate(ws, PERSON_ID, "person");
  // Schemas in the PRE-RETYPE drift shape: authors object-multi (source scope,
  // agent filter), linkedAuthors object-multi, the name properties person-scoped.
  push(ws, "propertySchema.create",
    {
      propertySchemaId: AUTHORS_ID,
      name: "Authors",
      type: "object",
      multi: true,
      scopeClassIds: [SOURCE_ID],
      targetClassFilter: [AGENT_ID],
    },
    []);
  push(ws, "propertySchema.create",
    {
      propertySchemaId: LINKED_AUTHORS_ID,
      name: "Linked authors",
      type: "object",
      multi: true,
      scopeClassIds: [SOURCE_ID],
      targetClassFilter: [AGENT_ID],
    },
    []);
  push(ws, "propertySchema.create",
    { propertySchemaId: GIVEN_NAME_ID, name: "Given name", type: "text", scopeClassIds: [PERSON_ID] },
    []);
  push(ws, "propertySchema.create",
    { propertySchemaId: FAMILY_NAME_ID, name: "Family name", type: "text", scopeClassIds: [PERSON_ID] },
    []);
  push(ws, "class.property.set", { classId: SOURCE_ID, propertySchemaId: AUTHORS_ID }, [SOURCE_ID]);
  push(ws, "class.property.set", { classId: SOURCE_ID, propertySchemaId: LINKED_AUTHORS_ID }, [SOURCE_ID]);
  push(ws, "class.property.set", { classId: PERSON_ID, propertySchemaId: GIVEN_NAME_ID }, [PERSON_ID]);
  push(ws, "class.property.set", { classId: PERSON_ID, propertySchemaId: FAMILY_NAME_ID }, [PERSON_ID]);

  // The agents.
  objectCreate(ws, AGENT_A, [PERSON_ID], "Ada Lovelace");
  nameSet(ws, AGENT_A, GIVEN_NAME_ID, "Ada");
  nameSet(ws, AGENT_A, FAMILY_NAME_ID, "Lovelace");
  objectCreate(ws, AGENT_B, [AGENT_ID], "Lord Byron"); // no name properties — title fallback
  objectCreate(ws, AGENT_C, [PERSON_ID], "Publius Vergilius Maro");
  nameSet(ws, AGENT_C, GIVEN_NAME_ID, "Virgil"); // given-name-only format corner
  objectCreate(ws, AGENT_D, [PERSON_ID], "Hannah Arendt");
  nameSet(ws, AGENT_D, GIVEN_NAME_ID, "Hannah");
  nameSet(ws, AGENT_D, FAMILY_NAME_ID, "Arendt");
  objectCreate(ws, AGENT_E, [PERSON_ID], "George Orwell");
  nameSet(ws, AGENT_E, GIVEN_NAME_ID, "George");
  nameSet(ws, AGENT_E, FAMILY_NAME_ID, "Orwell");

  // The sources + their object authors values.
  objectCreate(ws, SOURCE_S1, [SOURCE_ID], "Notes on the Analytical Engine");
  push(ws, "property.set",
    { objectId: SOURCE_S1, propertySchemaId: AUTHORS_ID, elementId: EL_A, idx: 0, value: { nodeId: AGENT_A } },
    [SOURCE_S1]);
  push(ws, "property.set",
    {
      objectId: SOURCE_S1,
      propertySchemaId: AUTHORS_ID,
      elementId: EL_B,
      idx: 1,
      value: { nodeId: AGENT_B },
      metadata: { note: "seed-metadata-rides-verbatim" },
    },
    [SOURCE_S1]);
  push(ws, "property.set",
    { objectId: SOURCE_S1, propertySchemaId: AUTHORS_ID, elementId: EL_E, idx: 2, value: { nodeId: AGENT_E } },
    [SOURCE_S1]);
  // The partially-converged corner: agentA is ALREADY linked — the copy must
  // add only agentB (agentE is deleted by the time the migration runs).
  push(ws, "property.set",
    { objectId: SOURCE_S1, propertySchemaId: LINKED_AUTHORS_ID, elementId: EL_LINKED_A, idx: 0, value: { nodeId: AGENT_A } },
    [SOURCE_S1]);

  objectCreate(ws, SOURCE_S2, [SOURCE_ID], "The Federalist Papers");
  // Legacy positional adds (no elementId — the deterministic row-id carrier).
  push(ws, "property.set",
    { objectId: SOURCE_S2, propertySchemaId: AUTHORS_ID, idx: 0, value: { nodeId: AGENT_C } },
    [SOURCE_S2]);
  push(ws, "property.set",
    { objectId: SOURCE_S2, propertySchemaId: AUTHORS_ID, idx: 1, value: { nodeId: AGENT_D } },
    [SOURCE_S2]);

  objectCreate(ws, SOURCE_S3, [SOURCE_ID], "A source with no authors");

  // Archive agentD (row survives — its name properties still drive the
  // rewrite), then PERMANENTLY delete agentE (row gone — the broken-ref
  // keep-value corner).
  push(ws, "object.update", { objectId: AGENT_D, active: false }, [AGENT_D]);
  push(ws, "object.delete", { objectId: AGENT_E, permanent: true }, [AGENT_E]);

  // The saved query view, authored BEFORE the migration: a property condition
  // on …0012 (the meaning-flip enumeration must list this) + a class-condition
  // control (must NOT be listed).
  push(ws, "object.create",
    {
      objectId: QUERIES_PAGE,
      isEmbedded: false,
      contentAst: [
        { type: "text", text: "Saved queries" },
        {
          type: "query",
          queryAst: {
            version: 1,
            scope: { type: "entire_workspace" },
            root: {
              type: "group",
              logic: "and",
              children: [{ type: "property", schemaId: AUTHORS_ID, op: "contains", value: "Lovelace" }],
            },
          },
        },
        {
          type: "query",
          queryAst: {
            version: 1,
            scope: { type: "entire_workspace" },
            root: {
              type: "group",
              logic: "and",
              children: [{ type: "class", classId: SOURCE_ID }],
            },
          },
        },
      ],
    },
    [QUERIES_PAGE]);

  // --- Workspace 2: already converged ----------------------------------------
  const wsConverged = WORKSPACE_CONVERGED;
  classCreate(wsConverged, SOURCE_ID, "source");
  classCreate(wsConverged, AGENT_ID, "agent");
  classCreate(wsConverged, PERSON_ID, "person");
  push(wsConverged, "propertySchema.create",
    { propertySchemaId: AUTHORS_ID, name: "Authors", type: "text", multi: true, scopeClassIds: [SOURCE_ID] },
    []);
  push(wsConverged, "propertySchema.create",
    {
      propertySchemaId: LINKED_AUTHORS_ID,
      name: "Linked authors",
      type: "object",
      multi: true,
      scopeClassIds: [SOURCE_ID],
      targetClassFilter: [AGENT_ID],
    },
    []);
  objectCreate(wsConverged, AGENT_A, [PERSON_ID], "Ada Lovelace");
  nameSet(wsConverged, AGENT_A, GIVEN_NAME_ID, "Ada");
  nameSet(wsConverged, AGENT_A, FAMILY_NAME_ID, "Lovelace");
  objectCreate(wsConverged, SOURCE_S1, [SOURCE_ID], "A converged source");
  push(wsConverged, "property.set",
    { objectId: SOURCE_S1, propertySchemaId: AUTHORS_ID, idx: 0, value: "Lovelace, Ada" },
    [SOURCE_S1]);
  push(wsConverged, "property.set",
    { objectId: SOURCE_S1, propertySchemaId: LINKED_AUTHORS_ID, elementId: EL_LINKED_A, idx: 0, value: { nodeId: AGENT_A } },
    [SOURCE_S1]);

  // --- Workspace 3: empty -----------------------------------------------------
  classCreate(WORKSPACE_EMPTY, SOURCE_ID, "source");

  return envelopes;
}

/**
 * Wipes `dataDir` and seeds the scratch relay. HARD-REFUSES any dir not
 * under /tmp — fail loud rather than wipe a real relay data dir.
 */
export function seedScratchRelay(dataDir: string): RelayStorage {
  const resolved = resolve(dataDir);
  if (resolved !== "/tmp" && !resolved.startsWith("/tmp/")) {
    throw new Error(
      `refusing to wipe ${resolved} — the scratch seed harness only accepts --data-dir under /tmp`,
    );
  }
  rmSync(resolved, { recursive: true, force: true });
  const relay = new RelayStorage(
    join(resolved, "relay.db"),
    join(resolved, "snapshots"),
  );
  const envelopes = buildSeedEnvelopes();
  const { savedIds } = relay.ingest(envelopes);
  if (savedIds.length !== envelopes.length) {
    relay.close();
    throw new Error(`seed ingest saved ${savedIds.length}/${envelopes.length} envelopes`);
  }
  return relay;
}

function main(): void {
  const index = process.argv.indexOf("--data-dir");
  const dataDir = index >= 0 ? process.argv[index + 1]! : "/tmp/notees-authors-scratch";
  const relay = seedScratchRelay(dataDir);
  relay.close();
  console.log(
    `scratch relay seeded at ${resolve(dataDir)}: 3 workspaces — ` +
      `${WORKSPACE_MAIN} (object-typed authors: PG5 + positional values, archived/deleted agent refs, ` +
      "a partial linkedAuthors corner, the pre-migration saved query view), " +
      `${WORKSPACE_CONVERGED} (already text-multi — a re-run must plan nothing), ` +
      `${WORKSPACE_EMPTY} (empty).`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
