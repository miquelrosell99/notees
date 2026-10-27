import { afterEach, describe, expect, it } from "vitest";

import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

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

/** Seed two tag pages (A colored, B plain) and one content node; returns their ids. */
async function seedTagsScenario(): Promise<{ tagA: string; tagB: string; note: string }> {
  const tagA = (
    await api("POST", "/api/objects", { payload: { isEmbedded: false, name: "Tag A" } })
  ).json().id;
  await api("PATCH", `/api/objects/${tagA}`, { payload: { color: "sky" } });
  const tagB = (
    await api("POST", "/api/objects", { payload: { isEmbedded: false, name: "Tag B" } })
  ).json().id;
  const note = (
    await api("POST", "/api/objects", { payload: { isEmbedded: false, name: "Tagged note" } })
  ).json().id;
  return { tagA, tagB, note };
}

describe("tags API", () => {
  it("GET exposes tagIds + resolved tags (name/color) and the list read carries tagIds", async () => {
    server = await makeTestServer();
    const { tagA, note } = await seedTagsScenario();

    const empty = (await api("GET", `/api/objects/${note}`)).json().object;
    expect(empty.tagIds).toEqual([]);
    expect(empty.tags).toEqual([]);

    await api("PUT", `/api/objects/${note}/tags/${tagA}`);
    const fetched = (await api("GET", `/api/objects/${note}`)).json().object;
    expect(fetched.tagIds).toEqual([tagA]);
    expect(fetched.tags).toEqual([{ id: tagA, name: "Tag A", color: "sky" }]);

    // The list surface projects the base shape too (parity with classIds).
    const listed = (
      await api("GET", `/api/objects?q=${encodeURIComponent("Tagged note")}`)
    ).json().objects as Array<{ id: string; tagIds: string[] }>;
    expect(listed.find((o) => o.id === note)?.tagIds).toEqual([tagA]);
  });

  it("PUT assigns, re-PUT is a no-op, a second tag accumulates sorted", async () => {
    server = await makeTestServer();
    const { tagA, tagB, note } = await seedTagsScenario();

    const first = await api("PUT", `/api/objects/${note}/tags/${tagA}`);
    expect(first.statusCode).toBe(200);
    expect(first.json().object.tagIds).toEqual([tagA]);

    // Idempotent by construction (OR-Set add): same tag_ids, tree untouched.
    const again = await api("PUT", `/api/objects/${note}/tags/${tagA}`);
    expect(again.statusCode).toBe(200);
    expect(again.json().object.tagIds).toEqual([tagA]);
    expect(again.json().object.parentId).toBeNull();

    const both = await api("PUT", `/api/objects/${note}/tags/${tagB}`);
    expect(both.statusCode).toBe(200);
    // recomputeTagIds sorts by tag_id.
    const sorted = [tagA, tagB].sort();
    expect(both.json().object.tagIds).toEqual(sorted);
    expect(both.json().object.tags.map((t: { id: string }) => t.id)).toEqual(sorted);
  });

  it("DELETE removes; DELETE of a non-member is a clean no-op; color unset reads null", async () => {
    server = await makeTestServer();
    const { tagA, tagB, note } = await seedTagsScenario();
    await api("PUT", `/api/objects/${note}/tags/${tagA}`);
    await api("PUT", `/api/objects/${note}/tags/${tagB}`);

    const removed = await api("DELETE", `/api/objects/${note}/tags/${tagA}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().object.tagIds).toEqual([tagB]);
    expect(removed.json().object.tags).toEqual([{ id: tagB, name: "Tag B", color: null }]);

    const noop = await api("DELETE", `/api/objects/${note}/tags/${tagA}`);
    expect(noop.statusCode).toBe(200);
    expect(noop.json().object.tagIds).toEqual([tagB]);
  });

  it("unknown tag id fails 404 on PUT (and DELETE); a class node is rejected as a tag", async () => {
    server = await makeTestServer();
    const { note } = await seedTagsScenario();

    const missing = crypto.randomUUID();
    const putMissing = await api("PUT", `/api/objects/${note}/tags/${missing}`);
    expect(putMissing.statusCode).toBe(404);
    expect(putMissing.json().error).toMatchObject({ code: "not_found", status: 404 });
    const deleteMissing = await api("DELETE", `/api/objects/${note}/tags/${missing}`);
    expect(deleteMissing.statusCode).toBe(404);

    // The tag page must be a page: a class node fails loud (the web tag
    // picker's page scope excludes classes — listPages filters is_class = 0).
    const classNode = (
      await api("POST", "/api/objects", { payload: { isClass: true, name: "Genre" } })
    ).json().id;
    const putClass = await api("PUT", `/api/objects/${note}/tags/${classNode}`);
    expect(putClass.statusCode).toBe(422);
    expect(putClass.json().error.code).toBe("validation_failed");
    // Sanity: the failed assign wrote nothing.
    expect((await api("GET", `/api/objects/${note}`)).json().object.tagIds).toEqual([]);
  });
});
