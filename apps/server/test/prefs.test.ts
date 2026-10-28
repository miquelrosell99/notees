/**
 * Per-user UI prefs tests: GET/PUT /api/me/prefs round-trip, auth
 * scoping (session vs API-key owner vs operator key vs anonymous), caps, and
 * uuid validation. Favorites/recents and cardsAlgorithm are server-side
 * per-user UI state — not op-log state. The last block pins the additive
 * cards_algorithm migration for relay.db files that predate the column.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

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

/** The AuthStorage seam is the honest second-account path for scoping tests. */
function createSecondUser(): { token: string } {
  const user = server!.ctx.auth.createUser({
    email: "second@example.com",
    passwordHash: "scrypt$16384$8$1$c2FsdA$hZ2ZoaDZk",
  });
  server!.ctx.auth.addMember(server!.ctx.defaultWorkspace, user.id, "owner");
  return { token: server!.ctx.auth.createSession(user.id).token };
}

const PAGE_A = "0192b000-0000-7000-8000-0000000000a1";
const PAGE_B = "0192b000-0000-7000-8000-0000000000b2";
const PAGE_C = "0192b000-0000-7000-8000-0000000000c3";

/** Deterministic valid uuidv7-shaped id from an integer (unique per i). */
const idNum = (i: number): string => `0192b000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`;

describe("GET /api/me/prefs", () => {
  it("returns the empty default for an account that never wrote prefs", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      favorites: [],
      recents: [],
      cardsAlgorithm: "fsrs",
      updatedAt: 0,
    });
  });

  it("defaults cardsAlgorithm to fsrs for a user who never set it", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().cardsAlgorithm).toBe("fsrs");
  });

  it("rejects anonymous callers and the operator API key (not a user)", async () => {
    server = await makeTestServer();
    await setupUser();
    const anonymous = await server.app.inject({ method: "GET", url: "/api/me/prefs" });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe("unauthenticated");
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
    const created = await server.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "cli" },
    });
    const apiKeyToken = created.json().token as string;
    const response = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { "x-api-key": apiKeyToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().favorites).toEqual([]);
  });
});

describe("PUT /api/me/prefs", () => {
  it("round-trips favorites and recents (each list replaces wholesale)", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };

    const first = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: auth,
      payload: { favorites: [PAGE_A, PAGE_B], recents: [PAGE_B, PAGE_A] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().favorites).toEqual([PAGE_A, PAGE_B]);
    expect(first.json().recents).toEqual([PAGE_B, PAGE_A]);
    expect(first.json().updatedAt).toBeGreaterThan(0);

    // Patch ONE list: the other survives untouched.
    const second = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: auth,
      payload: { favorites: [PAGE_C] },
    });
    expect(second.json().favorites).toEqual([PAGE_C]);
    expect(second.json().recents).toEqual([PAGE_B, PAGE_A]);

    const read = await server.app.inject({ method: "GET", url: "/api/me/prefs", headers: auth });
    expect(read.json().recents).toEqual([PAGE_B, PAGE_A]);
  });

  it("round-trips the cardsAlgorithm pref and survives other patches", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };

    const first = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: auth,
      payload: { cardsAlgorithm: "sm2" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().cardsAlgorithm).toBe("sm2");

    // A list-only patch must not clobber the algorithm.
    await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: auth,
      payload: { favorites: [PAGE_A] },
    });
    const read = await server.app.inject({ method: "GET", url: "/api/me/prefs", headers: auth });
    expect(read.json().cardsAlgorithm).toBe("sm2");
    expect(read.json().favorites).toEqual([PAGE_A]);

    const back = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: auth,
      payload: { cardsAlgorithm: "fsrs" },
    });
    expect(back.json().cardsAlgorithm).toBe("fsrs");
  });

  it("rejects a bogus cardsAlgorithm value", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const response = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
      payload: { cardsAlgorithm: "bogus" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("validation_failed");
  });

  it("scopes cardsAlgorithm per user like the lists", async () => {
    server = await makeTestServer();
    const admin = await setupUser();
    const second = createSecondUser();
    await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { cardsAlgorithm: "sm2" },
    });
    const secondRead = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(secondRead.json().cardsAlgorithm).toBe("fsrs");
  });

  it("dedupes order-preservingly before enforcing the caps", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const response = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
      payload: { favorites: [PAGE_A, PAGE_A, PAGE_B, PAGE_A] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().favorites).toEqual([PAGE_A, PAGE_B]);
  });

  it("rejects over-cap lists, non-uuid entries, unknown keys, and empty bodies", async () => {
    server = await makeTestServer();
    const { token } = await setupUser();
    const auth = { authorization: `Bearer ${token}` };

    const overCapRecents = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: auth,
      payload: { recents: Array.from({ length: 51 }, (_, i) => idNum(i)) },
    });
    expect(overCapRecents.statusCode).toBe(422);

    const overCapFavorites = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: auth,
      payload: { favorites: Array.from({ length: 501 }, (_, i) => idNum(i)) },
    });
    expect(overCapFavorites.statusCode).toBe(422);

    const badUuid = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: auth,
      payload: { favorites: ["not-a-uuid"] },
    });
    expect(badUuid.statusCode).toBe(422);

    const unknownKey = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: auth,
      payload: { favorites: [PAGE_A], theme: "dark" },
    });
    expect(unknownKey.statusCode).toBe(422);

    const empty = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: auth,
      payload: {},
    });
    expect(empty.statusCode).toBe(422);
  });

  it("scopes prefs per user: one account never sees another's lists", async () => {
    server = await makeTestServer();
    const admin = await setupUser();
    const second = createSecondUser();

    await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { favorites: [PAGE_A], recents: [PAGE_A] },
    });
    await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${second.token}` },
      payload: { favorites: [PAGE_B], recents: [PAGE_B] },
    });

    const adminRead = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const secondRead = await server.app.inject({
      method: "GET",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(adminRead.json().favorites).toEqual([PAGE_A]);
    expect(secondRead.json().favorites).toEqual([PAGE_B]);
  });

  it("creates the prefs row on first write (upsert), keyed by user id", async () => {
    server = await makeTestServer();
    const { token, userId } = await setupUser();
    // Never written: no row, the read path synthesizes the empty default.
    expect(server.ctx.auth.getUserPrefs(userId)).toEqual({
      favorites: [],
      recents: [],
      cardsAlgorithm: "fsrs",
      updatedAt: 0,
    });
    const response = await server.app.inject({
      method: "PUT",
      url: "/api/me/prefs",
      headers: { authorization: `Bearer ${token}` },
      payload: { favorites: [PAGE_A] },
    });
    expect(response.statusCode).toBe(200);
    expect(server.ctx.auth.getUserPrefs(userId).favorites).toEqual([PAGE_A]);
  });
});

describe("user_prefs cards_algorithm migration", () => {
  it("adds the column to a pre-migration table: existing rows read fsrs, patches round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "notees-prefs-migration-"));
    const dbPath = join(dir, "auth.db");
    try {
      // The pre-migration shape: favorites + recents, no cards_algorithm.
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE user_prefs (
            user_id TEXT PRIMARY KEY,
            favorites TEXT NOT NULL DEFAULT '[]',
            recents TEXT NOT NULL DEFAULT '[]',
            updated_at INTEGER NOT NULL
        );
        INSERT INTO user_prefs (user_id, favorites, recents, updated_at)
            VALUES ('user-a', '["${PAGE_A}"]', '[]', 100);
      `);
      legacy.close();

      const migrated = new AuthStorage(dbPath);
      // The ALTER backfilled the existing row to the fsrs default.
      expect(migrated.getUserPrefs("user-a")).toEqual({
        favorites: [PAGE_A],
        recents: [],
        cardsAlgorithm: "fsrs",
        updatedAt: 100,
      });
      // And the new column accepts the merge patch.
      expect(migrated.updateUserPrefs("user-a", { cardsAlgorithm: "sm2" }).cardsAlgorithm).toBe("sm2");
      expect(migrated.getUserPrefs("user-a").cardsAlgorithm).toBe("sm2");
      migrated.close();

      // Idempotent: a second boot over the migrated file is a no-op.
      const reopened = new AuthStorage(dbPath);
      expect(reopened.getUserPrefs("user-a").cardsAlgorithm).toBe("sm2");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
