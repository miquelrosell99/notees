/**
 * Workflow rules (issue #13) — the server-side engine and the CRUD surface.
 *
 * Engine: a node created matching a rule's criteria gets the rule's action
 * written as an ordinary envelope by a server actor (client "rules-engine");
 * a non-matching node writes nothing; the loop policy holds (a rule's action
 * never re-triggers the same rule — skipped_loop; chains beyond depth 1 do
 * not execute — skipped_depth_cap); a disabled rule no-ops until enabled; a
 * failing action ingest is audited and never blocks the triggering ingest.
 *
 * Routes: owner/admin write gate (operator key, admin session, owner
 * membership pass; strangers get 401, plain members 403), any authenticated
 * principal reads, fail-loud 422 validation (unknown trigger, broken or
 * aggregated criteria), 404s, restart persistence on relay.db, and the
 * coordination-state invariant — rule CRUD stamps NO envelope.
 */

import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { SYSTEM_CLASS_UUIDS } from "@notees/domain";
import type { Child, QueryAst } from "@notees/query";

import { buildServer } from "../src/index.js";
import { hashPassword } from "../src/auth.js";
import {
  closeTestServer,
  makeConfig,
  makeTestServer,
  testEnvelope,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

function api(method: string, url: string, options: { payload?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...server!.authHeaders, ...(options.headers ?? {}) };
  if (options.payload !== undefined) headers["content-type"] = "application/json";
  return server!.app.inject({
    method: method as "GET",
    url,
    headers,
    ...(options.payload !== undefined ? { payload: options.payload as Record<string, unknown> } : {}),
  });
}

function ast(children: Child[]): QueryAst {
  return {
    version: 2,
    scope: { type: "entire_workspace" },
    root: { type: "group", logic: "and", children },
  };
}

interface RuleBody {
  name: string;
  enabled?: boolean;
  trigger: { opType: string };
  criteria: unknown;
  actions: Array<Record<string, unknown>>;
}

/** The create endpoint does not check schema existence — a placeholder uuid keeps 422s about the case under test. */
const PLACEHOLDER_SCHEMA_ID = "00000000-0000-7000-8000-000000000001";

function ruleBody(overrides: Partial<RuleBody> = {}): RuleBody {
  return {
    name: "flag papers",
    trigger: { opType: "object.create" },
    criteria: ast([{ type: "member", family: "class", op: "in", target: { mode: "ids", ids: [SYSTEM_CLASS_UUIDS.journal_article] } }]),
    actions: [{ type: "property.set", propertySchemaId: PLACEHOLDER_SCHEMA_ID, value: "review" }],
    ...overrides,
  };
}

async function createSchema(name: string, type: string): Promise<string> {
  const res = await api("POST", "/api/property-schemas", {
    payload: { propertySchemaId: crypto.randomUUID(), name, type },
  });
  expect(res.statusCode).toBe(201);
  return res.json().propertySchema.id as string;
}

/** A rule whose action writes `value` to `schemaId`, created over the API. */
async function createRule(schemaId: string, overrides: Partial<RuleBody> = {}) {
  const res = await api("POST", "/api/workflows", {
    payload: ruleBody({ actions: [{ type: "property.set", propertySchemaId: schemaId, value: "review" }], ...overrides }),
  });
  expect(res.statusCode).toBe(201);
  return res.json().rule as { id: string };
}

async function createNode(name: string, classIds: string[] = []): Promise<string> {
  // Plan-07: seed through the relay (the object write API is retired). The
  // retired API ensured the system seeds on every call — mirror that so the
  // class tables the rules engine reads exist (relay ingest does not seed).
  await server!.ctx.ensureSeeded(server!.ctx.defaultWorkspace);
  const objectId = crypto.randomUUID();
  const res = await api("POST", "/api/relay/v2/batch", {
    payload: {
      envelopes: [
        testEnvelope({
          workspaceId: server!.ctx.defaultWorkspace,
          opType: "object.create",
          payload: { objectId, isEmbedded: false, contentAst: [{ type: "text", text: name }], classIds },
        }),
      ],
    },
  });
  expect(res.statusCode).toBe(200);
  return objectId;
}

async function setProperty(objectId: string, propertySchemaId: string, value: unknown): Promise<void> {
  const res = await api("POST", "/api/relay/v2/batch", {
    payload: {
      envelopes: [
        testEnvelope({
          workspaceId: server!.ctx.defaultWorkspace,
          opType: "property.set",
          payload: { objectId, propertySchemaId, value, idx: 0 },
        }),
      ],
    },
  });
  expect(res.statusCode).toBe(200);
}

async function effectiveValues(objectId: string, schemaId: string): Promise<unknown[]> {
  // Read the derived store directly — the server serves no content reads.
  return server!.ctx.workspaces
    .storeFor(server!.ctx.defaultWorkspace)
    .getEffectiveProperties(objectId)
    .filter((row) => row.propertySchemaId === schemaId)
    .map((row) => row.value);
}

/** Every envelope the rules engine wrote to the default workspace's log. */
function engineEnvelopes(): Array<{ id: string; opType: string; payload: Record<string, unknown> }> {
  return server!.ctx.relay
    .allEnvelopes(server!.ctx.defaultWorkspace)
    .filter((env) => env.client === "rules-engine")
    .map((env) => ({ id: env.id, opType: env.opType, payload: env.payload as Record<string, unknown> }));
}

async function runsOf(ruleId: string): Promise<Array<{ outcome: string; nodeId: string; triggerEnvelopeId: string; detail: string | null; actionsWritten: Array<{ opType: string; envelopeId: string }> }>> {
  const res = await api("GET", `/api/workflows/${ruleId}/runs`);
  expect(res.statusCode).toBe(200);
  return res.json().runs;
}


describe("workflow routes (issue #13)", () => {
  it("rejects unauthenticated calls on every route", async () => {
    server = await makeTestServer();
    const created = await api("POST", "/api/workflows", { payload: ruleBody() });
    const ruleId = created.json().rule.id as string;
    const responses = [
      await server.app.inject({ method: "GET", url: "/api/workflows" }),
      await server.app.inject({ method: "POST", url: "/api/workflows", payload: ruleBody() }),
      await server.app.inject({ method: "GET", url: `/api/workflows/${ruleId}` }),
      await server.app.inject({ method: "PATCH", url: `/api/workflows/${ruleId}`, payload: { enabled: false } }),
      await server.app.inject({ method: "DELETE", url: `/api/workflows/${ruleId}` }),
      await server.app.inject({ method: "GET", url: `/api/workflows/${ruleId}/runs` }),
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("unauthenticated");
    }
  });

  it("read: any authenticated principal; write: owner/admin only", async () => {
    server = await makeTestServer();
    const owner = server.ctx.auth.createUser({
      email: "owner@example.com",
      passwordHash: await hashPassword("owner-password-1"),
      isAdmin: false,
    });
    server.ctx.auth.addMember(server.ctx.defaultWorkspace, owner.id, "owner");
    const member = server.ctx.auth.createUser({
      email: "member@example.com",
      passwordHash: await hashPassword("member-password-1"),
      isAdmin: false,
    });
    server.ctx.auth.addMember(server.ctx.defaultWorkspace, member.id, "member");
    const admin = server.ctx.auth.createUser({
      email: "admin@example.com",
      passwordHash: await hashPassword("admin-password-1"),
      isAdmin: true,
    });
    // Bearer-only headers: merging these with the operator x-api-key would
    // resolve to the operator principal and defeat the gate under test.
    // content-type rides only on requests with a JSON body.
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    const json = (token: string) => ({ ...as(token), "content-type": "application/json" });
    const ownerHeaders = as(server.ctx.auth.createSession(owner.id).token);
    const ownerJson = json(server.ctx.auth.createSession(owner.id).token);
    const memberHeaders = as(server.ctx.auth.createSession(member.id).token);
    const memberJson = json(server.ctx.auth.createSession(member.id).token);
    const adminHeaders = as(server.ctx.auth.createSession(admin.id).token);
    const adminJson = json(server.ctx.auth.createSession(admin.id).token);

    // A plain member reads but cannot write.
    const list = await server.app.inject({ method: "GET", url: "/api/workflows", headers: memberHeaders });
    expect(list.statusCode).toBe(200);
    const denied = await server.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: memberJson,
      payload: ruleBody(),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("forbidden");

    // Owner membership and the admin session both write.
    const asOwner = await server.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: ownerJson,
      payload: ruleBody(),
    });
    expect(asOwner.statusCode).toBe(201);
    const asAdmin = await server.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: adminJson,
      payload: ruleBody({ name: "second" }),
    });
    expect(asAdmin.statusCode).toBe(201);

    // …and both can patch/delete what exists.
    const ruleId = asOwner.json().rule.id as string;
    expect((await server.app.inject({
      method: "PATCH",
      url: `/api/workflows/${ruleId}`,
      headers: ownerJson,
      payload: { enabled: false },
    })).statusCode).toBe(200);
    expect((await server.app.inject({
      method: "DELETE",
      url: `/api/workflows/${ruleId}`,
      headers: adminHeaders,
    })).statusCode).toBe(200);
  });

  it("validates fail-loud (422): unknown trigger, broken/aggregated criteria, bad actions, unknown keys", async () => {
    server = await makeTestServer();
    const aggregationCriteria = {
      ...ast([{ type: "member", family: "class", op: "in", target: { mode: "ids", ids: [SYSTEM_CLASS_UUIDS.journal_article] } }]),
      aggregation: { dimensions: [], measures: [{ function: "count", kind: "node" }] },
    };
    const bad: Array<[string, unknown]> = [
      ["unknown trigger opType", ruleBody({ trigger: { opType: "object.delete" } })],
      ["unknown condition type", ruleBody({ criteria: ast([{ type: "teleports", nodeId: crypto.randomUUID() } as unknown as Child]) })],
      ["aggregation in criteria", ruleBody({ criteria: aggregationCriteria })],
      ["empty actions", ruleBody({ actions: [] })],
      ["too many actions", ruleBody({ actions: Array.from({ length: 11 }, () => ({ type: "class.assign", classId: SYSTEM_CLASS_UUIDS.journal_article })) })],
      ["bad action uuid", ruleBody({ actions: [{ type: "property.set", propertySchemaId: "nope", value: 1 }] })],
      ["unknown body key", { ...ruleBody(), surprise: true }],
      ["empty name", ruleBody({ name: "  " })],
    ];
    for (const [label, payload] of bad) {
      const response = await api("POST", "/api/workflows", { payload: payload as Record<string, unknown> });
      expect(response.statusCode, label).toBe(422);
      expect(response.json().error.code, label).toBe("validation_failed");
    }
    const list = await api("GET", "/api/workflows");
    expect(list.json().rules).toHaveLength(0);
  });

  it("GET/PATCH/DELETE/runs on a ghost id → 404; an invalid patch body → 422", async () => {
    server = await makeTestServer();
    const ghost = crypto.randomUUID();
    for (const response of [
      await api("GET", `/api/workflows/${ghost}`),
      await api("PATCH", `/api/workflows/${ghost}`, { payload: { enabled: true } }),
      await api("DELETE", `/api/workflows/${ghost}`),
      await api("GET", `/api/workflows/${ghost}/runs`),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("not_found");
    }

    const created = await api("POST", "/api/workflows", { payload: ruleBody() });
    const ruleId = created.json().rule.id as string;
    const badPatch = await api("PATCH", `/api/workflows/${ruleId}`, { payload: { enabled: "yes" } });
    expect(badPatch.statusCode).toBe(422);
    const emptyPatch = await api("PATCH", `/api/workflows/${ruleId}`, { payload: {} });
    expect(emptyPatch.statusCode).toBe(422);
    // A rejected criteria patch leaves the stored rule untouched.
    const aggregated = {
      ...ast([]),
      aggregation: { dimensions: [], measures: [{ function: "count", kind: "node" }] },
    };
    const badCriteria = await api("PATCH", `/api/workflows/${ruleId}`, { payload: { criteria: aggregated } });
    expect(badCriteria.statusCode).toBe(422);
    const fetched = await api("GET", `/api/workflows/${ruleId}`);
    expect(fetched.json().rule.criteria).toEqual(created.json().rule.criteria);
  });

  it("the client evaluator's run upload appends rows readable through GET runs (ghost → 404, bad body → 422)", async () => {
    server = await makeTestServer();
    const created = await api("POST", "/api/workflows", { payload: ruleBody() });
    const ruleId = created.json().rule.id as string;

    const ghost = await api("POST", `/api/workflows/${crypto.randomUUID()}/runs`, {
      payload: { runs: [{ triggerEnvelopeId: "e", nodeId: "n", actionsWritten: [], outcome: "skipped_loop" }] },
    });
    expect(ghost.statusCode).toBe(404);

    const bad = await api("POST", `/api/workflows/${ruleId}/runs`, {
      payload: { runs: [{ triggerEnvelopeId: "e", nodeId: "n", actionsWritten: [], outcome: "exploded" }] },
    });
    expect(bad.statusCode).toBe(422);

    const uploaded = await api("POST", `/api/workflows/${ruleId}/runs`, {
      payload: {
        runs: [
          {
            triggerEnvelopeId: "0192a000-0000-7000-8000-0000000000e1",
            nodeId: "0192a000-0000-7000-8000-0000000000e2",
            actionsWritten: [{ opType: "property.set", envelopeId: "0192a000-0000-7000-8000-0000000000e3" }],
            outcome: "actions_written",
            detail: null,
          },
          {
            triggerEnvelopeId: "0192a000-0000-7000-8000-0000000000e1",
            nodeId: "0192a000-0000-7000-8000-0000000000e2",
            actionsWritten: [],
            outcome: "skipped_depth_cap",
            detail: "rule chains beyond depth 1 do not execute",
          },
        ],
      },
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().count).toBe(2);

    const runs = await api("GET", `/api/workflows/${ruleId}/runs`);
    expect(runs.statusCode).toBe(200);
    const outcomes = (runs.json().runs as Array<{ outcome: string }>).map((run) => run.outcome).sort();
    expect(outcomes).toEqual(["actions_written", "skipped_depth_cap"]);
  });

  it("rules are coordination state: CRUD stamps no envelope; rows survive a restart", async () => {
    server = await makeTestServer();
    const schemaId = await createSchema("wf-flag", "text");
    const before = server.ctx.relay.envelopeCount(server.ctx.defaultWorkspace);
    const created = await api("POST", "/api/workflows", {
      payload: ruleBody({ actions: [{ type: "property.set", propertySchemaId: schemaId, value: "review" }] }),
    });
    expect(created.statusCode).toBe(201);
    const ruleId = created.json().rule.id as string;
    await api("PATCH", `/api/workflows/${ruleId}`, { payload: { name: "renamed" } });

    // Plan 07: post-ingest probes are RETIRED — ingesting a matching
    // envelope writes no rules-engine op and no run row.
    await createNode("wf-restart", [SYSTEM_CLASS_UUIDS.journal_article]);
    expect(engineEnvelopes()).toHaveLength(0);
    const runs = await api("GET", `/api/workflows/${ruleId}/runs`);
    expect(runs.json().runs).toEqual([]);

    // Rule CRUD alone never touched the op log.
    const total = server.ctx.relay.envelopeCount(server.ctx.defaultWorkspace);
    expect(total - before).toBe(1); // just the object.create

    const dataDir = server.dataDir;
    const apiKey = server.apiKey;
    await server.app.close();
    server = null;

    const rebuilt = await buildServer(makeConfig(dataDir), { logger: false });
    try {
      const headers = { "x-api-key": apiKey };
      const list = await rebuilt.app.inject({ method: "GET", url: "/api/workflows", headers });
      expect(list.statusCode).toBe(200);
      expect(list.json().rules).toHaveLength(1);
      expect(list.json().rules[0]).toMatchObject({ id: ruleId, name: "renamed" });
      // Plan 07: probes retired — the audit table survives the restart but
      // carries no rows (nothing evaluated).
      const runs = await rebuilt.app.inject({ method: "GET", url: `/api/workflows/${ruleId}/runs`, headers });
      expect(runs.statusCode).toBe(200);
      expect(runs.json().runs).toEqual([]);
    } finally {
      await rebuilt.app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("post-ingest probes retired (plan 07)", () => {
  it("a matching trigger envelope ingests cleanly with NO evaluation: no rules-engine op, no run row, rule intact", async () => {
    server = await makeTestServer();
    await server.ctx.ensureSeeded(server.ctx.defaultWorkspace);
    const rule = await api("POST", "/api/workflows", {
      payload: ruleBody({
        trigger: { opType: "class.assign" },
        criteria: ast([{ type: "member", family: "class", op: "in", target: { mode: "ids", ids: [SYSTEM_CLASS_UUIDS.journal_article] } }]),
        actions: [{ type: "class.assign", classId: SYSTEM_CLASS_UUIDS.book }],
      }),
    });
    expect(rule.statusCode).toBe(201);

    const objectId = crypto.randomUUID();
    const ingested = await api("POST", "/api/relay/v2/batch", {
      payload: {
        envelopes: [
          testEnvelope({
            workspaceId: server!.ctx.defaultWorkspace,
            opType: "object.create",
            payload: {
              objectId,
              isEmbedded: false,
              contentAst: [{ type: "text", text: "wf-probe" }],
              classIds: [SYSTEM_CLASS_UUIDS.journal_article],
            },
          }),
        ],
      },
    });
    expect(ingested.statusCode).toBe(200);

    // The envelope committed; the probe never ran.
    const row = server!.ctx.workspaces.storeFor(server!.ctx.defaultWorkspace).getNode(objectId);
    expect(row).toBeDefined();
    expect(JSON.parse(row!.class_ids)).toEqual([SYSTEM_CLASS_UUIDS.journal_article]);
    expect(engineEnvelopes()).toHaveLength(0);
    const runs = await api("GET", `/api/workflows/${rule.json().rule.id}/runs`);
    expect(runs.json().runs).toEqual([]);
  });
});
