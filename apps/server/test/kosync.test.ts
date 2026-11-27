/**
 * The kosync server surface (KOReader Progress Sync): the device-facing
 * endpoints under /api/kosync — healthcheck, authenticated registration
 * (a Notees-side gesture; the device LOGS IN), kosync auth
 * (x-auth-user/x-auth-key), progress upsert/fetch/list — and the reading-
 * tracker mirror (metadata title match → Estado + read dates onto the date
 * chain).
 *
 * Protocol verified 2026-11-27 against the public specs (ryOS kosync-api
 * doc, nperez0111/koreader-sync, oboku's koReader sync notes).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeTestServer, ingest, makeTestServer, pagePayload, testEnvelope, type TestServer } from "./helpers";

let server: TestServer | null = null;

function api(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return server!.app.inject({
    method: method as "GET",
    url,
    headers: { ...server!.authHeaders, "x-workspace-id": server!.workspaceId, "content-type": "application/json", ...headers },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
}

/** A kosync-device call: NO Notees auth, kosync credentials in headers. */
function kosync(method: string, url: string, payload?: unknown, user = "reader", key = "md5-of-password") {
  return server!.app.inject({
    method: method as "GET",
    url,
    headers: { "content-type": "application/json", "x-auth-user": user, "x-auth-key": key },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
}

const PROGRESS_BODY = {
  document: "8b03a82761fae0ee6cd5a23700361e74",
  progress: "/body/DocFragment[15]/body/div[65]/text()[1].41",
  percentage: 0.2082,
  device: "kobo",
  device_id: "DEV1CE",
  metadata: { filename: "gatsby.epub", title: "The Great Gatsby", authors: "F. Scott Fitzgerald" },
};

beforeEach(async () => {
  server = await makeTestServer();
});

afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

describe("the kosync surface", () => {
  it("healthcheck answers OK without auth", async () => {
    const res = await server!.app.inject({ method: "GET", url: "/api/kosync/healthcheck" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: "OK" });
  });

  it("registration requires Notees auth; the device logs in with the registered credentials", async () => {
    // Unauthenticated registration refuses with the honest pointer.
    const anon = await server!.app.inject({
      method: "POST",
      url: "/api/kosync/users/create",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ username: "reader", password: "md5-of-password" }),
    });
    expect(anon.statusCode).toBe(403);

    // The Notees-side gesture registers (operator key here).
    const created = await api("POST", "/api/kosync/users/create", { username: "reader", password: "md5-of-password" });
    expect(created.statusCode).toBe(201);

    // Duplicate username fails loud.
    const dup = await api("POST", "/api/kosync/users/create", { username: "reader", password: "other" });
    expect(dup.statusCode).toBe(409);

    // The device authenticates with x-auth-user / x-auth-key only.
    expect((await kosync("GET", "/api/kosync/users/auth")).statusCode).toBe(200);
    const bad = await kosync("GET", "/api/kosync/users/auth", undefined, "reader", "wrong");
    expect(bad.statusCode).toBe(401);
  });

  it("progress upsert/fetch/list round-trips; the tracker mirror lands on a matching book", async () => {
    await api("POST", "/api/kosync/users/create", { username: "reader", password: "md5-of-password" });

    // A book node + the tracker vocabulary in the workspace.
    const bookPayload = pagePayload("The Great Gatsby, de F. Scott Fitzgerald");
    await ingest(server!, [testEnvelope({ opType: "object.create", payload: bookPayload })]);
    const bookId = bookPayload.objectId as string;
    const randomUUID = (await import("node:crypto")).randomUUID;
    const estadoId = randomUUID();
    const estado = await api("POST", "/api/property-schemas", {
      propertySchemaId: estadoId,
      name: "Estado",
      type: "select",
      options: [
        { id: randomUUID(), label: "Pendiente" },
        { id: randomUUID(), label: "Leyendo" },
        { id: randomUUID(), label: "Consumido" },
      ],
    });
    expect(estado.statusCode).toBe(201);
    for (const name of ["Primera lectura", "Última lectura"]) {
      const res = await api("POST", "/api/property-schemas", { propertySchemaId: randomUUID(), name, type: "datetime" });
      expect(res.statusCode).toBe(201);
    }

    // In-progress PUT: Leyendo + Última lectura (no Primera yet).
    const put1 = await kosync("PUT", "/api/kosync/syncs/progress", PROGRESS_BODY);
    expect(put1.statusCode).toBe(200);
    const ts1 = put1.json().timestamp as number;

    const got1 = await kosync("GET", `/api/kosync/syncs/progress/${PROGRESS_BODY.document}`);
    expect(got1.statusCode).toBe(200);
    expect(got1.json()).toMatchObject({ percentage: 0.2082, title: "The Great Gatsby", timestamp: ts1 });

    // The mirror: Estado = Leyendo on the book.
    // The objects REST is retired — the mirror is verified on the derived store.
    const propsOf = (schemaName: string) =>
      server!.ctx.workspaces
        .storeFor(server!.workspaceId)
        .database.prepare(
          `SELECT pv.value FROM property_value pv JOIN property_schema ps ON ps.id = pv.property_schema_id
           WHERE pv.node_id = ? AND ps.name = ?`,
        )
        .all(bookId, schemaName) as Array<{ value: string }>;
    expect(propsOf("Estado").length).toBe(1);
    expect(propsOf("Última lectura").length).toBe(1);
    expect(propsOf("Primera lectura").length).toBe(0);

    // Finished PUT: Consumido + both dates (primera filled once).
    const put2 = await kosync("PUT", "/api/kosync/syncs/progress", { ...PROGRESS_BODY, percentage: 1, progress: "100" });
    expect(put2.statusCode).toBe(200);
    expect(put2.json().timestamp).toBeGreaterThanOrEqual(ts1);
    expect(propsOf("Primera lectura").length).toBe(1);

    // Unknown document 404s; the list carries both... one document.
    expect((await kosync("GET", "/api/kosync/syncs/progress/unknown")).statusCode).toBe(404);
    const list = await kosync("GET", "/api/kosync/syncs/documents");
    expect(list.statusCode).toBe(200);
    expect((list.json().documents as unknown[]).length).toBe(1);

    // Wrong kosync credentials never touch the data.
    expect((await kosync("PUT", "/api/kosync/syncs/progress", PROGRESS_BODY, "reader", "wrong")).statusCode).toBe(401);
  });

  it("progress without a matching book still stores (durability boundary), unmatched", async () => {
    await api("POST", "/api/kosync/users/create", { username: "reader", password: "md5-of-password" });
    const put = await kosync("PUT", "/api/kosync/syncs/progress", {
      ...PROGRESS_BODY,
      document: "ffffffffffffffffffffffffffffffff",
      metadata: { title: "A Book That Is Not In The Library", authors: "Nobody" },
    });
    expect(put.statusCode).toBe(200);
    expect((await kosync("GET", "/api/kosync/syncs/progress/ffffffffffffffffffffffffffffffff")).statusCode).toBe(200);
  });
});
