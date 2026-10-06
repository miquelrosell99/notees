/**
 * Remap tooling (owner ruling 2026-10-04, reshaped by the owner's
 * design directive the same day) — one-shot migration of a workspace's
 * hand-rolled meeting-ish classes onto the seeded system family:
 *
 *   - classes whose DERIVED TITLE is exactly "reunión" get their members
 *     assigned the system `meeting` class; classes titled exactly "evento"
 *     get the system `event` class (the calendar family root — `meeting`
 *     extends `event`). Title match: case-insensitive, trimmed, exact (no
 *     accent folding — "reunion" ≠ "reunión"; "Eventos" stays put).
 *   - ONE assign op per member through the objects API (PUT
 *     /api/objects/:id/classes/:classId — the CLI `class remap` precedent).
 *     Assignment ONLY: the old classes and their memberships stay untouched
 *     (NO deletions, NO unassigns — the inverse is a later deliberate
 *     `notees class empty`). Every write is recoverable (membership unassign
 *     survives authored values; the trash covers the rest).
 *   - the system family (event root: class + eventDate schema/binding;
 *     meeting subclass: class + meetingDate/location/agenda + the
 *     meeting→event extends edge) is ensured FIRST at the reserved seed ids,
 *     idempotently. The objects API has no class-create or setExtends route,
 *     so missing classes and the edge ride relay-batch envelopes (the
 *     migrate-mention-texts precedent); schemas + bindings ride the REST
 *     property routes. Re-running after a successful pass is a near-no-op
 *     (binding upserts only — the REST surface exposes no binding read, so
 *     the idempotent class.property.set upserts are issued unconditionally).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan
 * (classes, members, targets) and writes nothing.
 *
 * Usage (the tsx binary lives in apps/server; run from the repo root):
 *   pnpm --dir apps/server exec tsx ../../scripts/remap-reunion-evento.mts \
 *     --server http://127.0.0.1:8377 --data-dir ../../config/notees/sync \
 *     --workspace <workspace-uuid> [--apply]
 *
 * The module is import-safe (main runs only when executed directly) and its
 * plan/apply core is surface-driven, so tests can drive it against the
 * in-process client harness (apps/web/test/remap-reunion-evento.test.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { newEnvelope, type Envelope } from "../packages/protocol/src/index";
import { SYSTEM_CLASS_UUIDS } from "../packages/domain/src/index";

import {
  ensureMeetingFamily,
  type MeetingFamilySurface,
} from "../apps/web/src/ui/components/meetingFamily";
import type { ClientPropertySchema } from "../apps/web/src/core/workspace-client";

/**
 * The remap table (owner directive 2026-10-04): each source class title maps
 * to its system target — reunión → meeting (the subclass), evento → event
 * (the calendar root).
 */
export const REMAP_TARGETS: ReadonlyArray<{ title: string; classId: string }> = [
  { title: "reunión", classId: SYSTEM_CLASS_UUIDS.meeting },
  { title: "evento", classId: SYSTEM_CLASS_UUIDS.event },
];

/** The system target class id for a derived title, or undefined when the title is not a remap source. */
export function remapTargetFor(title: string): string | undefined {
  const normalized = title.trim().toLowerCase();
  return REMAP_TARGETS.find((target) => target.title.toLowerCase() === normalized)?.classId;
}

/** True when the title is a remap source (exact, case-insensitive, trimmed). */
export function isRemapSourceTitle(title: string): boolean {
  return remapTargetFor(title) !== undefined;
}

/**
 * The script's full surface: the family ensure composes the first block
 * (reads + class/schema/binding/extends writes); the remap adds class
 * listing, member listing and the membership assign over the objects API.
 */
export interface RemapScriptSurface extends MeetingFamilySurface {
  listClasses(): Promise<Array<{ id: string; name: string; memberCount: number }>>;
  listMembers(classId: string): Promise<Array<{ id: string; name: string }>>;
  assignClass(objectId: string, classId: string): Promise<void>;
}

export interface RemapPlanMember {
  id: string;
  name: string;
}

export interface RemapPlanEntry {
  classId: string;
  title: string;
  /** The system class this source's members are assigned (meeting or event). */
  targetClassId: string;
  members: RemapPlanMember[];
}

export interface RemapPlan {
  entries: RemapPlanEntry[];
  memberCount: number;
}

/** Collect the remap plan: every exactly-titled source class, its target, and its members. */
export async function buildRemapPlan(surface: RemapScriptSurface): Promise<RemapPlan> {
  const classes = await surface.listClasses();
  const sources = classes
    .map((cls) => ({ cls, targetClassId: remapTargetFor(cls.name) }))
    .filter((entry): entry is { cls: (typeof classes)[number]; targetClassId: string } =>
      entry.targetClassId !== undefined,
    )
    .sort(
      (a, b) => a.cls.name.localeCompare(b.cls.name) || a.cls.id.localeCompare(b.cls.id),
    );
  const entries: RemapPlanEntry[] = [];
  for (const { cls, targetClassId } of sources) {
    const members = (await surface.listMembers(cls.id))
      .map((member) => ({ id: member.id, name: member.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    entries.push({ classId: cls.id, title: cls.name, targetClassId, members });
  }
  return {
    entries,
    memberCount: entries.reduce((total, entry) => total + entry.members.length, 0),
  };
}

export interface RemapResult {
  dryRun: boolean;
  assigned: number;
  failures: Array<{ id: string; name: string; error: string }>;
}

/**
 * Execute the plan. `apply: false` (the default at the CLI) prints the blast
 * radius and writes nothing; `apply: true` issues one assign op per member
 * (to the entry's own target) and collects per-member failures without
 * aborting the run.
 */
export async function runRemap(
  surface: RemapScriptSurface,
  plan: RemapPlan,
  options: { apply: boolean; log?: (line: string) => void },
): Promise<RemapResult> {
  const log = options.log ?? ((): void => undefined);
  if (!options.apply) {
    log(
      `dry run: ${plan.memberCount} member(s) across ${plan.entries.length} class(es) would be assigned the system meeting/event classes; the source classes and their memberships stay untouched`,
    );
    for (const entry of plan.entries) {
      log(
        `  "${entry.title}" (${entry.classId}) → meeting/event target ${entry.targetClassId}: ${entry.members.length} member(s)`,
      );
      for (const member of entry.members) log(`    ${member.id}  ${member.name}`);
    }
    return { dryRun: true, assigned: 0, failures: [] };
  }
  const failures: Array<{ id: string; name: string; error: string }> = [];
  let assigned = 0;
  for (const entry of plan.entries) {
    for (const member of entry.members) {
      try {
        await surface.assignClass(member.id, entry.targetClassId);
        assigned += 1;
        log(`assigned ${entry.targetClassId} → ${member.id}  ${member.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ id: member.id, name: member.name, error: message });
        log(`FAILED ${member.id}  ${member.name}: ${message}`);
      }
    }
  }
  log(`done: ${assigned} member(s) assigned, ${failures.length} failure(s)`);
  return { dryRun: false, assigned, failures };
}

// --- CLI ----------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One-shot operator actor (the migrate-script fixed-actor precedent). */
const ACTOR = "01920000-0000-7000-8000-0000000000b1";

interface CliOptions {
  server: string;
  dataDir: string;
  workspace: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const server = (value("--server") ?? "http://127.0.0.1:8377").replace(/\/+$/, "");
  const dataDir = value("--data-dir") ?? "config/notees/sync";
  const workspace = value("--workspace") ?? "";
  if (!UUID_PATTERN.test(workspace)) {
    throw new Error(
      "a --workspace <uuid> is required (name resolution is the CLI's job; the operator key resolves ids server-side only)",
    );
  }
  return { server, dataDir, workspace, apply: argv.includes("--apply") };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = readFileSync(join(options.dataDir, "api_key.txt"), "utf8").trim();

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("x-api-key", apiKey);
    headers.set("x-workspace-id", options.workspace);
    const response = await fetch(`${options.server}${path}`, { ...init, headers });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (body.error?.message !== undefined) detail = body.error.message;
      } catch {
        // Non-JSON error body; keep the status-based message.
      }
      throw new Error(`${path} failed: ${detail}`);
    }
    return response;
  }

  async function getJson<T>(path: string): Promise<T> {
    return (await request(path)).json() as Promise<T>;
  }

  // class.create and class.setExtends have no REST routes — the envelope
  // path, like the CLI's extends remap. HLC logical counter keeps the
  // envelopes monotonic within the run.
  let logical = 0;
  async function submitEnvelopes(envelopes: Envelope[]): Promise<void> {
    for (let offset = 0; offset < envelopes.length; offset += 500) {
      const chunk = envelopes.slice(offset, offset + 500);
      await request("/api/relay/v2/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelopes: chunk }),
      });
    }
  }
  function envelope(opType: string, payload: Record<string, unknown>, affected: string[]): Envelope {
    return newEnvelope({
      workspaceId: options.workspace,
      actorId: ACTOR,
      deviceId: "remap-reunion-evento",
      client: "remap-reunion-evento",
      hlc: { physical: Date.now(), logical: logical++ },
      affectedNodeIds: affected,
      opType,
      payload,
    });
  }

  const surface: RemapScriptSurface = {
    async listClasses() {
      const body = await getJson<{
        classes: Array<{ id: string; name: string; memberCount: number }>;
      }>("/api/classes");
      return body.classes;
    },
    async listMembers(classId) {
      const body = await getJson<{ members: Array<{ id: string; name: string | null }> }>(
        `/api/classes/${encodeURIComponent(classId)}`,
      );
      return body.members.map((member) => ({ id: member.id, name: member.name ?? "" }));
    },
    async assignClass(objectId, classId) {
      await request(`/api/objects/${encodeURIComponent(objectId)}/classes/${encodeURIComponent(classId)}`, {
        method: "PUT",
      });
    },
    // --- MeetingFamilySurface (HTTP adapter; reads async, writes REST/batch) ---
    async getNodeRaw(id) {
      const response = await fetch(`${options.server}/api/classes/${encodeURIComponent(id)}`, {
        headers: { "x-api-key": apiKey, "x-workspace-id": options.workspace },
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`class read failed for ${id}: HTTP ${response.status}`);
      return (await response.json()) as { id: string };
    },
    async listPropertySchemas(): Promise<ClientPropertySchema[]> {
      const body = await getJson<{
        propertySchemas: Array<{
          id: string;
          name: string;
          type: string;
          multi: boolean;
          scope: string;
          options: unknown;
          targetClassFilter: unknown;
          datePrecision: unknown;
          dateQualified: unknown;
        }>;
      }>("/api/property-schemas");
      // The wire schema view (schemaView) carries every ClientPropertySchema
      // field with these exact names; the ensure only reads ids, so the
      // shape-faithful pass-through is safe.
      return body.propertySchemas.map((schema) => ({
        ...schema,
        options: (schema.options ?? null) as ClientPropertySchema["options"],
        targetClassFilter: (schema.targetClassFilter ?? null) as string[] | null,
        datePrecision: schema.datePrecision as ClientPropertySchema["datePrecision"],
        dateQualified: schema.dateQualified as boolean | null,
      }));
    },
    // The REST surface exposes no class-binding read; ensureMeetingFamily
    // therefore binds unconditionally (idempotent upserts — see header).
    async getClassBindings() {
      return [];
    },
    async getClassParents(classId) {
      const body = await getJson<{ class: { parentClassIds: string[] } }>(
        `/api/classes/${encodeURIComponent(classId)}`,
      );
      return body.class.parentClassIds;
    },
    async createClass(name, opts) {
      const classId = opts?.id ?? crypto.randomUUID();
      await submitEnvelopes([
        envelope(
          "class.create",
          {
            classId,
            // Title-is-content: the class's name is its text content.
            contentAst: [{ type: "text", text: name }],
            ...(opts?.icon !== undefined ? { icon: opts.icon } : {}),
          },
          [classId],
        ),
      ]);
      return classId;
    },
    async setClassExtends(classId, parentClassIds) {
      await submitEnvelopes([
        envelope("class.setExtends", { classId, parentClassIds }, [classId, ...parentClassIds]),
      ]);
    },
    async createPropertySchema(input) {
      await request("/api/property-schemas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          propertySchemaId: input.id,
          name: input.name,
          type: input.type,
          ...(input.multi !== undefined ? { multi: input.multi } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          ...(input.options !== undefined ? { options: input.options } : {}),
          ...(input.targetClassFilter !== undefined
            ? { targetClassFilter: input.targetClassFilter }
            : {}),
        }),
      });
      return input.id ?? "";
    },
    async setClassProperty(classId, propertySchemaId, fields) {
      await request(`/api/classes/${encodeURIComponent(classId)}/properties`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ propertySchemaId, ...fields }),
      });
    },
  };

  const log = (line: string): void => console.log(line);

  // 1. The targets must exist before any assign (PUT requireClass gate):
  //    the event root + the meeting subclass + the extends edge.
  await ensureMeetingFamily(surface);
  log(
    `meeting/event family ensured (${SYSTEM_CLASS_UUIDS.meeting} extends ${SYSTEM_CLASS_UUIDS.event}; classes + schemas + bindings + edge)`,
  );

  // 2. Plan, then assign (dry run unless --apply).
  const plan = await buildRemapPlan(surface);
  if (plan.entries.length === 0) {
    log('no classes titled "reunión"/"evento" found — nothing to remap.');
    return;
  }
  const result = await runRemap(surface, plan, { apply: options.apply, log });
  if (!options.apply) {
    log("re-run with --apply to execute (this was a dry run — nothing was written)");
  } else if (result.failures.length > 0) {
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
