/**
 * Keying gate tests — NOTEES_REQUIRE_KEYED (default ON).
 *
 * Workspace creation (POST /api/workspaces and the /:id/clone route) requires
 * a wrappedKey bundle when the hatch is on: without one the server answers
 * 422 keying_required BEFORE any workspace row is minted; with one the new
 * workspace is born keyed (encrypted: true, the key row readable by the
 * creating member). With the hatch off the legacy unkeyed creation path is
 * preserved. The seeded demo fixtures carry an explicit exemption allowlist
 * (KEYING_EXEMPT_WORKSPACE_IDS) — pinned exactly here.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KEYING_EXEMPT_WORKSPACE_IDS, keyingRequiredFor } from "../src/auth.js";
import type { ServerConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";

import {
  closeTestServer,
  ingest,
  makeTestServer,
  pagePayload,
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

async function setupUser(email = "admin@example.com"): Promise<{ token: string }> {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email, password: "admin-password-1" },
  });
  expect(response.statusCode).toBe(201);
  return { token: response.json().token as string };
}

function sessionHeaders(token: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

async function listWorkspaceIds(token: string): Promise<string[]> {
  const response = await server!.app.inject({
    method: "GET",
    url: "/api/workspaces",
    headers: sessionHeaders(token),
  });
  expect(response.statusCode).toBe(200);
  return (response.json().workspaces as Array<{ id: string }>).map((workspace) => workspace.id);
}

async function createWorkspace(
  token: string,
  payload: Record<string, unknown>,
): Promise<Awaited<ReturnType<TestServer["app"]["inject"]>>> {
  return server!.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: sessionHeaders(token),
    payload,
  });
}

describe("keying gate — POST /api/workspaces", () => {
  it("hatch ON + no bundle → 422 keying_required BEFORE any workspace row is minted", async () => {
    server = await makeTestServer({ requireKeyed: true });
    const { token } = await setupUser();
    const before = await listWorkspaceIds(token);

    const response = await createWorkspace(token, { name: "gated" });
    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("keying_required");
    expect(body.error.message).toContain("wrappedKey");

    // The rejection precedes the mint: the directory is unchanged.
    const after = await listWorkspaceIds(token);
    expect(after).toEqual(before);
  });

  it("hatch ON + a bundle → 201, listed encrypted: true, the wrap reads back for the owner", async () => {
    server = await makeTestServer({ requireKeyed: true });
    const { token } = await setupUser();

    const created = await createWorkspace(token, { name: "keyed", wrappedKey: "dGVzdA" });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const list = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: sessionHeaders(token),
    });
    const entry = (list.json().workspaces as Array<{ id: string; encrypted: boolean }>).find(
      (workspace) => workspace.id === id,
    );
    expect(entry?.encrypted).toBe(true);

    const key = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${id}/key`,
      headers: sessionHeaders(token),
    });
    expect(key.statusCode).toBe(200);
    expect(key.json()).toEqual({ wrappedKey: "dGVzdA" });
  });

  it("hatch OFF + no bundle → 201, legacy unkeyed creation is preserved (encrypted: false)", async () => {
    server = await makeTestServer({ requireKeyed: false });
    const { token } = await setupUser();

    const created = await createWorkspace(token, { name: "legacy" });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const list = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: sessionHeaders(token),
    });
    const entry = (list.json().workspaces as Array<{ id: string; encrypted: boolean }>).find(
      (workspace) => workspace.id === id,
    );
    expect(entry?.encrypted).toBe(false);
  });

  it("hatch ON + an oversized bundle → 422 validation_failed (the schema bounds hold)", async () => {
    server = await makeTestServer({ requireKeyed: true });
    const { token } = await setupUser();

    const response = await createWorkspace(token, { name: "big", wrappedKey: "x".repeat(4097) });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("validation_failed");
  });
});

describe("client-chosen id — POST /api/workspaces (offline adoption)", () => {
  it("hatch ON + a fresh explicit id + a bundle → 201, listed under THAT id", async () => {
    server = await makeTestServer({ requireKeyed: true });
    const { token } = await setupUser();
    const chosenId = "3f8c9d2e-1111-4222-8333-444455556666";

    const created = await createWorkspace(token, {
      id: chosenId,
      name: "adopted",
      wrappedKey: "YWRvcHQ",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: chosenId, name: "adopted", role: "owner" });

    const ids = await listWorkspaceIds(token);
    expect(ids).toContain(chosenId);
    const list = await server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: sessionHeaders(token),
    });
    const entry = (list.json().workspaces as Array<{ id: string; encrypted: boolean }>).find(
      (workspace) => workspace.id === chosenId,
    );
    expect(entry?.encrypted).toBe(true);
  });

  it("hatch ON + a CONFLICTING explicit id → 409, nothing minted or overwritten", async () => {
    server = await makeTestServer({ requireKeyed: true });
    const { token } = await setupUser();
    const existing = await createWorkspace(token, { name: " incumbent ", wrappedKey: "aW5jdW1iZW50" });
    expect(existing.statusCode).toBe(201);
    const existingId = (existing.json() as { id: string }).id;
    const before = await listWorkspaceIds(token);

    const response = await createWorkspace(token, {
      id: existingId,
      name: "squatter",
      wrappedKey: "cXVhdHRlcg",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("conflict");

    // The incumbent is untouched: same directory, same key row.
    const after = await listWorkspaceIds(token);
    expect(after).toEqual(before);
    const key = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${existingId}/key`,
      headers: sessionHeaders(token),
    });
    expect(key.statusCode).toBe(200);
    expect(key.json()).toEqual({ wrappedKey: "aW5jdW1iZW50" });
  });

  it("hatch ON + a non-exempt explicit id + no bundle → 422 keying_required (the gate reads the id)", async () => {
    server = await makeTestServer({ requireKeyed: true });
    const { token } = await setupUser();
    const before = await listWorkspaceIds(token);

    const response = await createWorkspace(token, {
      id: "5a1b2c3d-2222-4333-8444-555566667777",
      name: "gated-adoption",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("keying_required");

    const after = await listWorkspaceIds(token);
    expect(after).toEqual(before);
  });

  it("hatch ON + an allowlisted fixture id + no bundle → exempt from the gate (the mint still refuses: fixture ids are ingest-only)", async () => {
    server = await makeTestServer({ requireKeyed: true });
    const { token } = await setupUser();

    const response = await createWorkspace(token, {
      id: KEYING_EXEMPT_WORKSPACE_IDS[0],
      name: "fixture-squatter",
    });
    // NOT the keying gate: the allowlist exempts the id, and the store law
    // refuses the mint loud (seeded demo fixtures are minted only via
    // direct log ingest).
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("validation_failed");
    expect(response.json().error.message).toContain("direct log ingest");
  });

  it("a malformed explicit id → 422 validation_failed (the uuid bound holds)", async () => {
    server = await makeTestServer({ requireKeyed: true });
    const { token } = await setupUser();

    const response = await createWorkspace(token, { id: "not-a-uuid", wrappedKey: "dGVzdA" });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("validation_failed");
  });
});

describe("keying gate — POST /api/workspaces/:id/clone", () => {
  async function keyedSourceWithPage(token: string): Promise<string> {
    const created = await createWorkspace(token, { name: "source", wrappedKey: "c291cmNl" });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };
    const seeded = await ingest(server!, [
      testEnvelope({ workspaceId: id, opType: "object.create", payload: pagePayload("cloned page") }),
    ]);
    expect(seeded.statusCode).toBe(200);
    return id;
  }

  it("hatch ON + no bundle → 422 keying_required, no clone minted", async () => {
    server = await makeTestServer({ requireKeyed: true });
    const { token } = await setupUser();
    const sourceId = await keyedSourceWithPage(token);
    const before = await listWorkspaceIds(token);

    const response = await server.app.inject({
      method: "POST",
      url: `/api/workspaces/${sourceId}/clone`,
      headers: sessionHeaders(token),
      payload: { name: "copy" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("keying_required");

    const after = await listWorkspaceIds(token);
    expect(after).toEqual(before);
  });

  it("hatch ON + a bundle → 201, the clone carries its OWN key row (the source's wrap is not reused)", async () => {
    server = await makeTestServer({ requireKeyed: true });
    const { token } = await setupUser();
    const sourceId = await keyedSourceWithPage(token);

    const response = await server.app.inject({
      method: "POST",
      url: `/api/workspaces/${sourceId}/clone`,
      headers: sessionHeaders(token),
      payload: { name: "copy", wrappedKey: "Y2xvbmU" },
    });
    expect(response.statusCode).toBe(201);
    const { id: cloneId } = response.json() as { id: string };
    expect(cloneId).not.toBe(sourceId);

    const cloneKey = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${cloneId}/key`,
      headers: sessionHeaders(token),
    });
    expect(cloneKey.statusCode).toBe(200);
    expect(cloneKey.json()).toEqual({ wrappedKey: "Y2xvbmU" });

    // The source's custody row is untouched.
    const sourceKey = await server.app.inject({
      method: "GET",
      url: `/api/workspaces/${sourceId}/key`,
      headers: sessionHeaders(token),
    });
    expect(sourceKey.statusCode).toBe(200);
    expect(sourceKey.json()).toEqual({ wrappedKey: "c291cmNl" });
  });
});

describe("keyingRequiredFor — unit pins", () => {
  const hatchOn = { requireKeyed: true } as Pick<ServerConfig, "requireKeyed">;
  const hatchOff = { requireKeyed: false } as Pick<ServerConfig, "requireKeyed">;
  const randomId = crypto.randomUUID();

  it("the allowlist is exactly the two seeded demo fixtures", () => {
    expect(KEYING_EXEMPT_WORKSPACE_IDS).toEqual([
      "11111111-2222-4333-8444-555555555555",
      "4b7d1a00-2222-4000-8000-0000000000099",
    ]);
  });

  it("hatch ON: creation (null id) and non-exempt ids require keying; exempt ids do not", () => {
    expect(keyingRequiredFor(hatchOn, null)).toBe(true);
    expect(keyingRequiredFor(hatchOn, randomId)).toBe(true);
    for (const exemptId of KEYING_EXEMPT_WORKSPACE_IDS) {
      expect(keyingRequiredFor(hatchOn, exemptId)).toBe(false);
    }
  });

  it("hatch OFF: nothing requires keying", () => {
    expect(keyingRequiredFor(hatchOff, null)).toBe(false);
    expect(keyingRequiredFor(hatchOff, randomId)).toBe(false);
    expect(keyingRequiredFor(hatchOff, KEYING_EXEMPT_WORKSPACE_IDS[0]!)).toBe(false);
  });
});

describe("NOTEES_REQUIRE_KEYED config parsing", () => {
  const dataDirs: string[] = [];
  afterEach(() => {
    for (const dir of dataDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const dataDir = mkdtempSync(join(tmpdir(), "notees-config-test-"));
    dataDirs.push(dataDir);
    return { NOTEES_DATA_DIR: dataDir, ...extra } as NodeJS.ProcessEnv;
  }

  it("defaults ON; explicit values parse like the other bool hatches", () => {
    expect(loadConfig(env()).requireKeyed).toBe(true);
    expect(loadConfig(env({ NOTEES_REQUIRE_KEYED: "1" })).requireKeyed).toBe(true);
    expect(loadConfig(env({ NOTEES_REQUIRE_KEYED: "true" })).requireKeyed).toBe(true);
    expect(loadConfig(env({ NOTEES_REQUIRE_KEYED: "0" })).requireKeyed).toBe(false);
    expect(loadConfig(env({ NOTEES_REQUIRE_KEYED: "false" })).requireKeyed).toBe(false);
  });
});
