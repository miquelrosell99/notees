/**
 * §34.36 remap tooling (owner ruling 2026-10-04) — one-shot migration of a
 * workspace's hand-rolled meeting-ish classes onto the seeded system class:
 *
 *   - classes whose DERIVED TITLE is exactly "reunión" or "evento"
 *     (case-insensitive, trimmed — the live workspace carries ~52 + ~27
 *     members) get their members assigned the system `meeting` class, ONE op
 *     per member through the objects API (PUT /api/objects/:id/classes/:classId
 *     — the CLI `class remap` precedent). Assignment ONLY: the old classes
 *     and their memberships stay untouched (NO deletions, NO unassigns — the
 *     inverse is a later deliberate `notees class empty`). Every write is
 *     recoverable (membership unassign survives authored values; the trash
 *     covers the rest).
 *   - the meeting family (class node + meetingDate/location/agenda schemas +
 *     bindings) is ensured FIRST at the reserved seed ids, idempotently —
 *     the objects API has no class-create route, so a missing class rides one
 *     relay-batch envelope (the migrate-mention-texts precedent); schemas +
 *     bindings ride the REST property routes. Re-running the script after a
 *     successful pass is a near-no-op (binding upserts only — the REST
 *     surface exposes no binding read, so the three idempotent
 *     class.property.set upserts are issued unconditionally).
 *
 * DRY RUN BY DEFAULT: without --apply the script prints the full plan
 * (classes, members, target) and writes nothing.
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

import { newEnvelope } from "../packages/protocol/src/index";
import { SYSTEM_CLASS_UUIDS } from "../packages/domain/src/index";

import {
  ensureMeetingFamily,
  MEETING_CLASS_ID,
  type MeetingFamilySurface,
} from "../apps/web/src/ui/components/meetingFamily";
import type { ClientPropertySchema } from "../apps/web/src/core/workspace-client";

/** The source class titles — exact match (case-insensitive, trimmed), §34.36 M4. */
export const REMAP_SOURCE_TITLES: readonly string[] = ["reunión", "evento"];

/** The derived-title match: no substrings, no plurals ("Eventos" stays put). */
export function isRemapSourceTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return REMAP_SOURCE_TITLES.some((wanted) => normalized === wanted.toLowerCase());
}

/**
 * The script's full surface: the meeting-family ensure composes the first
 * three writes + reads; the remap adds class listing, member listing and the
 * membership assign over the objects API.
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
  members: RemapPlanMember[];
}

export interface RemapPlan {
  targetClassId: string;
  entries: RemapPlanEntry[];
  memberCount: number;
}

/** Collect the remap plan: every exactly-titled source class and its members. */
export async function buildRemapPlan(surface: RemapScriptSurface): Promise<RemapPlan> {
  const classes = await surface.listClasses();
  const sources = classes
    .filter((cls) => isRemapSourceTitle(cls.name))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const entries: RemapPlanEntry[] = [];
  for (const cls of sources) {
    const members = (await surface.listMembers(cls.id))
      .map((member) => ({ id: member.id, name: member.name }))
      .sort((a, b) => a.id.localeCompare(b.id));
    entries.push({ classId: cls.id, title: cls.name, members });
  }
  return {
    targetClassId: MEETING_CLASS_ID,
    entries,
    memberCount: entries.reduce((total, entry) => total + entry.members.length, 0),
  };
}

export interface RemapResult {
  dryRun: boolean;
  targetClassId: string;
  assigned: number;
  failures: Array<{ id: string; name: string; error: string }>;
}

/**
 * Execute the plan. `apply: false` (the default at the CLI) prints the blast
 * radius and writes nothing; `apply: true` issues one assign op per member
 * and collects per-member failures without aborting the run.
 */
export async function runRemap(
  surface: RemapScriptSurface,
  plan: RemapPlan,
  options: { apply: boolean; log?: (line: string) => void },
): Promise<RemapResult> {
  const log = options.log ?? ((): void => undefined);
  if (!options.apply) {
    log(
      `dry run: ${plan.memberCount} member(s) across ${plan.entries.length} class(es) would be assigned the system meeting class (${plan.targetClassId}); the source classes and their memberships stay untouched`,
    );
    for (const entry of plan.entries) {
      log(`  "${entry.title}" (${entry.classId}): ${entry.members.length} member(s)`);
      for (const member of entry.members) log(`    ${member.id}  ${member.name}`);
    }
    return { dryRun: true, targetClassId: plan.targetClassId, assigned: 0, failures: [] };
  }
  const failures: Array<{ id: string; name: string; error: string }> = [];
  let assigned = 0;
  for (const entry of plan.entries) {
    for (const member of entry.members) {
      try {
        await surface.assignClass(member.id, plan.targetClassId);
        assigned += 1;
        log(`assigned meeting → ${member.id}  ${member.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ id: member.id, name: member.name, error: message });
        log(`FAILED ${member.id}  ${member.name}: ${message}`);
      }
    }
  }
  log(`done: ${assigned} member(s) assigned, ${failures.length} failure(s)`);
  return { dryRun: false, targetClassId: plan.targetClassId, assigned, failures };
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

  /** class.create has no REST route — the envelope path, like the CLI's extends remap. */
  let logical = 0;
  async function createClassViaRelay(
    name: string,
    opts: { id?: string; icon?: string } = {},
  ): Promise<string> {
    const classId = opts.id ?? crypto.randomUUID();
    await request("/api/relay/v2/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        envelopes: [
          newEnvelope({
            workspaceId: options.workspace,
            actorId: ACTOR,
            deviceId: "remap-reunion-evento",
            client: "remap-reunion-evento",
            hlc: { physical: Date.now(), logical: logical++ },
            affectedNodeIds: [classId],
            opType: "class.create",
            payload: {
              classId,
              // Title-is-content: the class's name is its text content.
              contentAst: [{ type: "text", text: name }],
              ...(opts.icon !== undefined ? { icon: opts.icon } : {}),
            },
          }),
        ],
      }),
    });
    return classId;
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
    async createClass(name, opts) {
      return createClassViaRelay(name, opts);
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

  // 1. The target must exist before any assign (PUT requireClass gate).
  await ensureMeetingFamily(surface);
  log(`meeting family ensured at ${SYSTEM_CLASS_UUIDS.meeting} (class + schemas + bindings)`);

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
