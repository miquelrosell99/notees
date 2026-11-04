/**
 * Per-user prefs tests — ONE OPAQUE BLOB (plan 07).
 *
 * The server stores/returns the blob verbatim (64 KiB cap); it never
 * interprets it. The unwrapped JSON form (the keyless self-host shape) is
 * the one seam the server still reads: the ADS credential for /resolve.
 * Legacy four-column rows migrate to the unwrapped blob at open.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import { AuthStorage } from "../src/auth.js";
import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

async function setupUser(email = "admin@example.com"): Promise<{ token: string; userId: string }> {
  const response = await server!.app.inject({
    method: "POST",
    url: "/api/setup",
    payload: { email, password: "admin-password-1" },
  });
  expect(response.statusCode).toBe(201);
  return { token: response.json().token as string, userId: response.json().user.id as string };
}

const EMPTY_BLOB = JSON.stringify({ v: 1, favorites: [], recents: [], cardsAlgorithm: "fsrs", adsApiToken: "" });

describe("GET /api/me/prefs", () => {
  it("returns the empty UNWRAPPED default for an account that never wrote prefs", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ blob: EMPTY_BLOB, updatedAt: 0 });
  });

  it("rejects anonymous callers and the operator API key (not a user)", async () => {
    server = await makeTestServer();
    const anon = await server.app.inject({ method: "GET", url: "/api/me/prefs" });
    expect(anon.statusCode).toBe(401);
    const operator = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { "x-api-key": server.apiKey },
    });
    expect(operator.statusCode).toBe(401);
  });

  it("accepts a per-user API key (its owner as the principal)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const minted = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "machine" },
    });
    const response = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { "x-api-key": minted.json().token as string },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().blob).toBe(EMPTY_BLOB);
  });
});

describe("PUT /api/me/prefs — the opaque blob", () => {
  it("round-trips the blob verbatim (unwrapped form)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const blob = JSON.stringify({
      v: 1,
      favorites: ["0192a000-0000-7000-8000-000000000001"],
      recents: ["0192a000-0000-7000-8000-000000000002"],
      cardsAlgorithm: "sm2",
      adsApiToken: "",
    });
    const put = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
      payload: { blob },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ blob, updatedAt: expect.any(Number) as unknown as number });

    const got = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.json().blob).toBe(blob);
  });

  it("round-trips a WRAPPED blob opaquely (the server stores ciphertext verbatim)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    // b64u-shaped sealed bytes — indistinguishable from the real wrapped form.
    const wrapped = "AQIDBAUGBwgJCgsMqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
      payload: { blob: wrapped },
    });
    const got = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(got.json().blob).toBe(wrapped);
  });

  it("rejects a blob over the 64 KiB cap, a non-string blob, and unknown keys", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const headers = { authorization: `Bearer ${token}` };
    const oversized = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers,
      payload: { blob: "x".repeat(64 * 1024 + 1) },
    });
    expect(oversized.statusCode).toBe(422);
    const notString = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers,
      payload: { blob: 42 },
    });
    expect(notString.statusCode).toBe(422);
    const unknown = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers,
      payload: { blob: "{}", favorites: [] },
    });
    expect(unknown.statusCode).toBe(422);
  });

  it("scopes the blob per user: one account never sees another's", async () => {
    server = await makeTestServer();
    const a = await setupUser("a@example.com");
    const second = server!.ctx.auth.createUser({
      email: "b@example.com",
      passwordHash: "scrypt$16384$8$1$c2FsdA$hZ2ZoaDZk",
    });
    const b = { token: server!.ctx.auth.createSession(second.id).token };
    await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${a.token}` },
      payload: { blob: JSON.stringify({ v: 1, favorites: [], recents: [], cardsAlgorithm: "fsrs", adsApiToken: "a-secret" }) },
    });
    const got = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(got.json().blob).toBe(EMPTY_BLOB);
  });

  it("creates the prefs row on first write (upsert), keyed by user id", async () => {
    server = await makeTestServer();
    const { token, userId } = await setupUser();
    await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
      payload: { blob: EMPTY_BLOB },
    });
    const row = server.ctx.auth
      .getUserPrefs(userId);
    expect(row.blob).toBe(EMPTY_BLOB);
    expect(row.updatedAt).toBeGreaterThan(0);
  });
});

describe("legacy user_prefs migration", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("a pre-blob relay.db row becomes an UNWRAPPED blob at open (favorites/recents/algorithm/token preserved)", () => {
    const dir = mkdtempSync(join(tmpdir(), "notees-prefs-migration-"));
    dirs.push(dir);
    const dbPath = join(dir, "relay.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY, favorites TEXT NOT NULL DEFAULT '[]',
      recents TEXT NOT NULL DEFAULT '[]', cards_algorithm TEXT NOT NULL DEFAULT 'fsrs',
      ads_api_token TEXT, updated_at INTEGER NOT NULL)`);
    db.prepare(
      "INSERT INTO user_prefs (user_id, favorites, recents, cards_algorithm, ads_api_token, updated_at) VALUES (?, ?, ?, ?, ?, 7)",
    ).run(
      "user-1",
      JSON.stringify(["0192a000-0000-7000-8000-0000000000aa"]),
      JSON.stringify(["0192a000-0000-7000-8000-0000000000bb"]),
      "sm2",
      "ads-legacy-token",
    );
    db.close();

    const auth = new AuthStorage(dbPath);
    const prefs = auth.getUserPrefs("user-1");
    expect(JSON.parse(prefs.blob)).toEqual({
      v: 1,
      favorites: ["0192a000-0000-7000-8000-0000000000aa"],
      recents: ["0192a000-0000-7000-8000-0000000000bb"],
      cardsAlgorithm: "sm2",
      adsApiToken: "ads-legacy-token",
    });
    expect(prefs.updatedAt).toBe(7);
    auth.close();
  });
});
