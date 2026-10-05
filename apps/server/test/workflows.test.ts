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
    version: 1,
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
    criteria: ast([{ type: "class", classId: SYSTEM_CLASS_UUIDS.paper }]),
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
  const res = await api("POST", "/api/objects", {
    payload: {
      presentAsMain: true,
      contentAst: [{ type: "text", text: name }],
      classIds,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function setProperty(objectId: string, propertySchemaId: string, value: unknown): Promise<void> {
  const res = await api("POST", `/api/objects/${objectId}/properties`, {
    payload: { propertySchemaId, value, idx: 0 },
  });
  expect(res.statusCode).toBe(200);
}

async function effectiveValues(objectId: string, schemaId: string): Promise<unknown[]> {
  const res = await api("GET", `/api/objects/${objectId}/effective-properties`);
  expect(res.statusCode).toBe(200);
  return (res.json().properties as Array<{ schemaId: string; value: unknown }>)
    .filter((row) => row.schemaId === schemaId)
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

describe("workflow engine (issue #13)", () => {
  it("node created matching the criteria gets the rule's property.set (server actor, audited)", async () => {
    server = await makeTestServer();
    const schemaId = await createSchema("wf-flag", "text");
    const rule = await createRule(schemaId);

    const nodeId = await createNode("wf-paper-node", [SYSTEM_CLASS_UUIDS.paper]);

    // The effect: an authored value, visible through the derived read model.
    expect(await effectiveValues(nodeId, schemaId)).toEqual(["review"]);

    // The cause: ONE ordinary envelope by the rules-engine actor, wired like
    // any other op (same log, same derived store, no new op type).
    const engine = engineEnvelopes();
    expect(engine).toHaveLength(1);
    expect(engine[0]!.opType).toBe("property.set");
    expect(engine[0]!.payload).toMatchObject({ objectId: nodeId, propertySchemaId: schemaId, value: "review" });

    // The audit: one actions_written run pointing at both envelope and node.
    const createEnvelope = server.ctx.relay
      .allEnvelopes(server.ctx.defaultWorkspace)
      .find((env) => env.opType === "object.create" && (env.payload as { objectId?: string }).objectId === nodeId);
    const runs = await runsOf(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("actions_written");
    expect(runs[0]!.nodeId).toBe(nodeId);
    expect(runs[0]!.triggerEnvelopeId).toBe(createEnvelope!.id);
    expect(runs[0]!.actionsWritten).toEqual([{ opType: "property.set", envelopeId: engine[0]!.id }]);
  });

  it("criteria non-match → nothing written and no run row", async () => {
    server = await makeTestServer();
    const schemaId = await createSchema("wf-flag", "text");
    const rule = await createRule(schemaId);

    const nodeId = await createNode("wf-plain-node", []); // no paper class → criteria miss

    expect(await effectiveValues(nodeId, schemaId)).toEqual([]);
    expect(engineEnvelopes()).toHaveLength(0);
    expect(await runsOf(rule.id)).toEqual([]);
  });

  it("class.assign trigger fires on the class-add carrier and the action assigns a class", async () => {
    server = await makeTestServer();
    const res = await api("POST", "/api/workflows", {
      payload: ruleBody({
        name: "paper means academic",
        trigger: { opType: "class.assign" },
        criteria: ast([{ type: "class", classId: SYSTEM_CLASS_UUIDS.paper }]),
        actions: [{ type: "class.assign", classId: SYSTEM_CLASS_UUIDS.book }],
      }),
    });
    expect(res.statusCode).toBe(201);
    const rule = res.json().rule;

    const nodeId = await createNode("wf-academic", [SYSTEM_CLASS_UUIDS.paper]);

    const object = await api("GET", `/api/objects/${nodeId}`);
    const classIds = (object.json().object.classes as Array<{ id: string }>).map((entry) => entry.id);
    expect(classIds).toContain(SYSTEM_CLASS_UUIDS.book);
    // The carrier is a re-issued object.create — the wire's OR-Set add op.
    const engine = engineEnvelopes();
    expect(engine).toHaveLength(1);
    expect(engine[0]!.opType).toBe("object.create");
    expect(engine[0]!.payload).toMatchObject({ objectId: nodeId, classIds: [SYSTEM_CLASS_UUIDS.book] });
    // Two runs: the firing, and the loop-breaker echo — the class.assign
    // ACTION is itself a class-add carrier, so at depth 1 it trips the same
    // rule again and is recorded as skipped_loop (never re-executed).
    const runs = (await runsOf(rule.id)).map((run) => run.outcome).sort();
    expect(runs).toEqual(["actions_written", "skipped_loop"]);

    // A create WITHOUT classIds does not trip the class.assign trigger.
    await createNode("wf-plain", []);
    expect(engineEnvelopes()).toHaveLength(1);
    expect(await runsOf(rule.id)).toHaveLength(2);
  });

  it("loop cap: a rule's action never re-triggers the same rule (skipped_loop, one envelope)", async () => {
    server = await makeTestServer();
    const seedSchema = await createSchema("wf-seed", "text");
    const flagSchema = await createSchema("wf-flag", "text");
    // Fires when wf-seed exists on the node; its own action writes wf-flag,
    // whose criteria (wf-seed still exists) would match the rule again.
    const rule = await createRule(flagSchema, {
      trigger: { opType: "property.set" },
      criteria: ast([{ type: "property", schemaId: seedSchema, op: "exists" }]),
    });

    const nodeId = await createNode("wf-loop", []);
    await setProperty(nodeId, seedSchema, "seeded");

    // Exactly one engine envelope: the wf-flag write did NOT re-fire the rule.
    const engine = engineEnvelopes();
    expect(engine).toHaveLength(1);
    expect(engine[0]!.payload).toMatchObject({ propertySchemaId: flagSchema });
    expect(await effectiveValues(nodeId, flagSchema)).toEqual(["review"]);

    // The echo is audited, not executed.
    const runs = await runsOf(rule.id);
    expect(runs.map((run) => run.outcome).sort()).toEqual(["actions_written", "skipped_loop"]);
  });

  it("depth cap: chains beyond one hop do not execute (skipped_depth_cap)", async () => {
    server = await makeTestServer();
    const seedSchema = await createSchema("wf-seed", "text");
    const hop1Schema = await createSchema("wf-hop1", "text");
    const hop2Schema = await createSchema("wf-hop2", "text");

    // Rule B FIRST (evaluation order is creation order): "when wf-hop1
    // exists → write wf-hop2". At depth 0 B never matches — wf-hop1 appears
    // only as A's depth-1 action — so B's one and only chance is the capped
    // re-entry, where the depth cap must stop it.
    const resB = await api("POST", "/api/workflows", {
      payload: ruleBody({
        name: "B",
        trigger: { opType: "property.set" },
        criteria: ast([{ type: "property", schemaId: hop1Schema, op: "exists" }]),
        actions: [{ type: "property.set", propertySchemaId: hop2Schema, value: "chained" }],
      }),
    });
    expect(resB.statusCode).toBe(201);
    const ruleB = resB.json().rule;
    // Rule A: wf-seed present → write wf-hop1.
    await createRule(hop1Schema, {
      name: "A",
      trigger: { opType: "property.set" },
      criteria: ast([{ type: "property", schemaId: seedSchema, op: "exists" }]),
    });

    const nodeId = await createNode("wf-chain", []);
    await setProperty(nodeId, seedSchema, "seeded");

    // A fired once; B's match at depth 1 wrote nothing.
    expect(engineEnvelopes()).toHaveLength(1);
    expect(await effectiveValues(nodeId, hop1Schema)).toEqual(["review"]);
    expect(await effectiveValues(nodeId, hop2Schema)).toEqual([]);
    const runsB = await runsOf(ruleB.id);
    expect(runsB).toHaveLength(1);
    expect(runsB[0]!.outcome).toBe("skipped_depth_cap");
    expect(runsB[0]!.actionsWritten).toEqual([]);
  });

  it("disabled rule no-ops; enabling makes it fire", async () => {
    server = await makeTestServer();
    const schemaId = await createSchema("wf-flag", "text");
    const rule = await createRule(schemaId, { enabled: false });

    await createNode("wf-while-disabled", [SYSTEM_CLASS_UUIDS.paper]);
    expect(engineEnvelopes()).toHaveLength(0);
    expect(await runsOf(rule.id)).toEqual([]);

    const patched = await api("PATCH", `/api/workflows/${rule.id}`, { payload: { enabled: true } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().rule.enabled).toBe(true);

    await createNode("wf-after-enable", [SYSTEM_CLASS_UUIDS.paper]);
    expect(engineEnvelopes()).toHaveLength(1);
    expect(await runsOf(rule.id)).toHaveLength(1);
  });

  it("a failing action is audited (actions_failed) and never blocks the triggering ingest", async () => {
    server = await makeTestServer();
    // A number-typed schema rejects a string value at apply time
    // (PB2/PG6 shape integrity, fail loud) — after the envelope persisted
    // to the log, exactly the failure mode the audit must absorb.
    const numberSchema = await createSchema("wf-count", "number");
    const res = await api("POST", "/api/workflows", {
      payload: ruleBody({
        actions: [{ type: "property.set", propertySchemaId: numberSchema, value: "not-a-number" }],
      }),
    });
    expect(res.statusCode).toBe(201);
    const rule = res.json().rule;

    const created = await api("POST", "/api/objects", {
      payload: {
        presentAsMain: true,
        contentAst: [{ type: "text", text: "wf-failing" }],
        classIds: [SYSTEM_CLASS_UUIDS.paper],
      },
    });
    expect(created.statusCode).toBe(201);
    const nodeId = created.json().id as string;

    // The derived store took NO partial effect…
    expect(await effectiveValues(nodeId, numberSchema)).toEqual([]);
    // …the failure is a first-class audit row with the error message…
    const runs = await runsOf(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("actions_failed");
    expect(runs[0]!.detail).toBeTruthy();
    // …and the client can keep writing (the ingest path is unharmed).
    const after = await api("POST", "/api/objects", {
      payload: { presentAsMain: true, contentAst: [{ type: "text", text: "wf-after-failure" }] },
    });
    expect(after.statusCode).toBe(201);
  });
});

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
      ...ast([{ type: "class", classId: SYSTEM_CLASS_UUIDS.paper }]),
      aggregation: { dimensions: [], measures: [{ function: "count", kind: "node" }] },
    };
    const bad: Array<[string, unknown]> = [
      ["unknown trigger opType", ruleBody({ trigger: { opType: "object.delete" } })],
      ["unknown condition type", ruleBody({ criteria: ast([{ type: "teleports", nodeId: crypto.randomUUID() } as unknown as Child]) })],
      ["aggregation in criteria", ruleBody({ criteria: aggregationCriteria })],
      ["empty actions", ruleBody({ actions: [] })],
      ["too many actions", ruleBody({ actions: Array.from({ length: 11 }, () => ({ type: "class.assign", classId: SYSTEM_CLASS_UUIDS.paper })) })],
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

    // Fire one run so the audit has a row to persist.
    await createNode("wf-restart", [SYSTEM_CLASS_UUIDS.paper]);
    expect(engineEnvelopes()).toHaveLength(1);

    // Rule CRUD alone never touched the op log (the action envelope did).
    const total = server.ctx.relay.envelopeCount(server.ctx.defaultWorkspace);
    expect(total - before).toBe(2); // object.create + the rule's property.set

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
      const runs = await rebuilt.app.inject({ method: "GET", url: `/api/workflows/${ruleId}/runs`, headers });
      expect(runs.statusCode).toBe(200);
      expect(runs.json().runs[0].outcome).toBe("actions_written");
    } finally {
      await rebuilt.app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
