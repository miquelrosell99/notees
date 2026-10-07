import { afterEach, describe, expect, it } from "vitest";

import { newEnvelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

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

describe("objects API", () => {
  it("create → get round-trip", async () => {
    server = await makeTestServer();
    const created = await api("POST", "/api/objects", {
      payload: { presentAsMain: true, name: "Round Trip", contentAst: [{ type: "text", text: "hello body" }] },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const fetched = await api("GET", `/api/objects/${id}`);
    expect(fetched.statusCode).toBe(200);
    const object = fetched.json().object;
    expect(object).toMatchObject({ id, isClass: false, presentAsMain: true, isActive: true });
    // Title-is-content: `name` is no longer stored (the convenience field is
    // dropped when an explicit contentAst rides along); the API name is the
    // title derived from the content.
    expect(object.name).toBe("hello body");
    expect(object.contentAst).toEqual([{ type: "text", text: "hello body" }]);
    expect(object.workspaceId).toBe(server.ctx.defaultWorkspace);
  });

  it("PATCH updates fields (LWW: the later write wins)", async () => {
    server = await makeTestServer();
    const { id } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Before" } })).json();
    const patched = await api("PATCH", `/api/objects/${id}`, { payload: { contentAst: [{ type: "text", text: "After" }] } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().object.contentAst).toEqual([{ type: "text", text: "After" }]);

    await api("PATCH", `/api/objects/${id}`, { payload: { contentAst: [{ type: "text", text: "Second" }] } });
    const fetched = await api("GET", `/api/objects/${id}`);
    expect(fetched.json().object.contentAst).toEqual([{ type: "text", text: "Second" }]);
  });

  it("PATCH on a missing object is a 404 envelope", async () => {
    server = await makeTestServer();
    const res = await api("PATCH", `/api/objects/${crypto.randomUUID()}`, { payload: { contentAst: [{ type: "text", text: "ghost" }] } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: "not_found", status: 404 });
  });

  it("soft delete keeps the object retrievable; permanent delete removes it", async () => {
    server = await makeTestServer();
    const { id } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Doomed" } })).json();

    const soft = await api("DELETE", `/api/objects/${id}`);
    expect(soft.statusCode).toBe(200);
    expect(soft.json()).toMatchObject({ id, deleted: true, permanent: false });

    const fetched = await api("GET", `/api/objects/${id}`);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().object.isActive).toBe(false);

    const noConfirm = await api("DELETE", `/api/objects/${id}?permanent=true`);
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json().error.code).toBe("validation_failed");

    const confirmed = await api("DELETE", `/api/objects/${id}?permanent=true&confirm=${id}`);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().permanent).toBe(true);

    const gone = await api("GET", `/api/objects/${id}`);
    expect(gone.statusCode).toBe(404);
  });

  it("objects list supports isClass/presentAsMain filters and cursor pagination", async () => {
    server = await makeTestServer();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { id } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: `p${i}` } })).json();
      ids.push(id);
    }
    const block = (await api("POST", "/api/objects", { payload: { presentAsMain: false, name: "b1", parentId: ids[0] } })).json();
    expect(block.id).toBeTruthy();

    // The pages-ish listing is the document-chrome predicate (non-class
    // roots + main children); parented rows with the bit unset stay out.
    const page1 = (await api("GET", "/api/objects?presentAsMain=true&limit=2")).json();
    expect(page1.objects).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await api("GET", `/api/objects?presentAsMain=true&limit=2&cursor=${page1.nextCursor}`)).json();
    expect(page2.objects).toHaveLength(2);
    expect(new Set([...page1.objects.map((o: { id: string }) => o.id), ...page2.objects.map((o: { id: string }) => o.id)]).size).toBe(4);

    const blocks = (await api("GET", "/api/objects?presentAsMain=false")).json();
    expect(blocks.objects.map((o: { id: string }) => o.id)).toContain(block.id);
    expect(blocks.objects.every((o: { isClass: boolean; presentAsMain: boolean }) => o.isClass === false && o.presentAsMain === false)).toBe(true);

    const nonClasses = (await api("GET", "/api/objects?isClass=false")).json();
    expect(nonClasses.objects.map((o: { id: string }) => o.id)).toContain(block.id);
  });

  it("children endpoint returns active children in child-position order", async () => {
    server = await makeTestServer();
    const { id: parent } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Host" } })).json();
    const { id: a } = (
      await api("POST", "/api/objects", { payload: { presentAsMain: false, name: "first", parentId: parent } })
    ).json();
    const { id: b } = (
      await api("POST", "/api/objects", { payload: { presentAsMain: false, name: "second", parentId: parent } })
    ).json();
    const { id: c } = (
      await api("POST", "/api/objects", { payload: { presentAsMain: false, name: "third", parentId: parent } })
    ).json();
    // A main child (child page): the endpoint returns every active child,
    // both render zones — filtering to the inline body is the caller's job.
    const { id: main } = (
      await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "main child", parentId: parent } })
    ).json();

    // Invert the position order with an object.move (ids stay creation-ordered,
    // so id order and child order genuinely differ). The crafted HLC runs
    // ahead of the server-stamped creates, so the move wins the LWW compare.
    const move = newEnvelope({
      workspaceId: server.ctx.defaultWorkspace,
      actorId: "99999999-8888-4777-8666-555555555555",
      deviceId: "test",
      hlc: { physical: Date.now() + 1000, logical: 0 },
      opType: "object.move",
      payload: { objectId: c, parentId: parent, beforeId: a },
    });
    const ingested = await api("POST", "/api/relay/v2/batch", { payload: { envelopes: [move] } });
    expect(ingested.statusCode).toBe(200);
    expect(ingested.json()).toMatchObject({ savedCount: 1, savedIds: [move.id] });

    const res = await api("GET", `/api/objects/${parent}/children`);
    expect(res.statusCode).toBe(200);
    const children = res.json().children;
    expect(children.map((o: { id: string }) => o.id)).toEqual([c, a, b, main]);
    // The full projection rides along (same shape as GET /objects/:id).
    expect(children[0]).toMatchObject({ id: c, parentId: parent, presentAsMain: false, isActive: true });
    expect(children[0].contentAst).toEqual([{ type: "text", text: "third" }]);

    // Trashing a child drops it from the list (soft delete keeps the
    // child-order row; the endpoint filters it) — order preserved otherwise.
    await api("DELETE", `/api/objects/${a}`);
    const after = (await api("GET", `/api/objects/${parent}/children`)).json().children;
    expect(after.map((o: { id: string }) => o.id)).toEqual([c, b, main]);
  });

  it("children endpoint 404s for a missing parent", async () => {
    server = await makeTestServer();
    const res = await api("GET", `/api/objects/${crypto.randomUUID()}/children`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: "not_found", status: 404 });
  });

  it("search finds inserted content", async () => {
    server = await makeTestServer();
    const { id } = (
      await api("POST", "/api/objects", {
        payload: {
          presentAsMain: true,
          name: "Searchable",
          contentAst: [{ type: "text", text: "quixotic expedition notes" }],
        },
      })
    ).json();
    const res = await api("GET", "/api/search?q=quixotic");
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { id: string }) => r.id)).toContain(id);
  });

  it("search paginates with a cursor until nextCursor comes back null", async () => {
    server = await makeTestServer();
    for (let i = 0; i < 5; i++) {
      await api("POST", "/api/objects", {
        payload: { presentAsMain: true, name: `Cursorpage ${i}`, contentAst: [{ type: "text", text: "cursorword body" }] },
      });
    }
    const first = await api("GET", "/api/search?q=cursorword&limit=2");
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.results).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const second = await api("GET", `/api/search?q=cursorword&limit=2&cursor=${page1.nextCursor}`);
    const page2 = second.json();
    expect(page2.results).toHaveLength(2);
    const ids1 = new Set(page1.results.map((r: { id: string }) => r.id));
    expect(page2.results.every((r: { id: string }) => !ids1.has(r.id))).toBe(true);
    const third = await api("GET", `/api/search?q=cursorword&limit=2&cursor=${page2.nextCursor}`);
    expect(third.json().results).toHaveLength(1);
    expect(third.json().nextCursor).toBeNull();
    // A garbage cursor is a 422, never a silent reset to page one.
    const bad = await api("GET", "/api/search?q=cursorword&cursor=abc");
    expect(bad.statusCode).toBe(422);
  });

  it("search supports quoted phrases", async () => {
    server = await makeTestServer();
    await api("POST", "/api/objects", {
      payload: { presentAsMain: true, contentAst: [{ type: "text", text: "the quick brown fox" }] },
    });
    await api("POST", "/api/objects", {
      payload: { presentAsMain: true, contentAst: [{ type: "text", text: "quick fox brown" }] },
    });
    const res = await api("GET", "/api/search?q=%22quick%20brown%22");
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(1);
    expect(res.json().results[0].name).toBe("the quick brown fox");
  });

  it("resolve maps an exact display name to an id", async () => {
    server = await makeTestServer();
    const { id } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "My Source" } })).json();
    const res = await api("GET", `/api/resolve?name=${encodeURIComponent("my source")}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, name: "My Source" });
    // Prefix-only or partial names do not resolve (exact match semantics).
    const partial = await api("GET", `/api/resolve?name=${encodeURIComponent("My")}`);
    expect(partial.statusCode).toBe(404);
    expect(partial.json().error).toMatchObject({ code: "not_found" });
  });

  it("resolve treats an exact alias value as a name-equivalent", async () => {
    server = await makeTestServer();
    // The alias schema is seeded (global scope, multi text) — author a value
    // and resolve by it.
    const { id } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "The Republic" } })).json();
    const aliasWrite = await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: SYSTEM_PROPERTY_UUIDS.alias, value: "Politeia", idx: 0 },
    });
    expect(aliasWrite.statusCode).toBe(200);
    const res = await api("GET", `/api/resolve?name=${encodeURIComponent("politeia")}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    // Searching the alias text also finds the node (text-scalar indexing).
    const search = await api("GET", `/api/search?q=Politeia`);
    expect(search.json().results.map((r: { id: string }) => r.id)).toContain(id);
  });

  it("resolve folds a NODE alias to its main page", async () => {
    server = await makeTestServer();
    const main = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Productivity" } })).json();
    const alias = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Getting Things Done" } })).json();
    // The wire-field carrier: object.update {aliasedNodeId} on the ALIAS.
    const link = await api("PATCH", `/api/objects/${alias.id}`, {
      payload: { aliasedNodeId: main.id },
    });
    expect(link.statusCode).toBe(200);
    // Resolving the ALIAS page's title answers the MAIN page — the store
    // chain-walker collapses the chain (cycle-safe, depth-capped).
    const res = await api("GET", `/api/resolve?name=${encodeURIComponent("getting things done")}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: main.id, name: "Productivity" });
    // Resolving the main's own name is unchanged.
    const direct = await api("GET", `/api/resolve?name=${encodeURIComponent("productivity")}`);
    expect(direct.json().id).toBe(main.id);
  });

  it("apply-time value validation fails loud as 422", async () => {
    server = await makeTestServer();
    const { id } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Dated" } })).json();
    const schema = (await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: crypto.randomUUID(), name: "when", type: "date" },
    })).json().propertySchema;
    // A date value must reference an EXISTING node — a ghost fails loud.
    const ghost = await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: schema.id, value: { nodeId: crypto.randomUUID() }, idx: 0 },
    });
    expect(ghost.statusCode).toBe(422);
    expect(ghost.json().error.code).toBe("validation_failed");
    expect(ghost.json().error.message).toContain("does not exist");
    // A wrong scalar shape on a typed schema fails loud too.
    const boolSchema = (await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: crypto.randomUUID(), name: "done", type: "boolean" },
    })).json().propertySchema;
    const bad = await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: boolSchema.id, value: "yes", idx: 0 },
    });
    expect(bad.statusCode).toBe(422);
    // A single-value schema rejects idx > 0 (cardinality).
    const textSchema = (await api("POST", "/api/property-schemas", {
      payload: { propertySchemaId: crypto.randomUUID(), name: "note", type: "text" },
    })).json().propertySchema;
    const secondSlot = await api("POST", `/api/objects/${id}/properties`, {
      payload: { propertySchemaId: textSchema.id, value: "x", idx: 1 },
    });
    expect(secondSlot.statusCode).toBe(422);
    expect(secondSlot.json().error.message).toContain("single-value");
  });

  it("backlinks reflect an emitted mention", async () => {
    server = await makeTestServer();
    const { id: target } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Target" } })).json();
    const { id: source } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Source" } })).json();
    // Title-is-content: pages carry text-only content, so the mention token
    // rides in a block child of the source page.
    const { id: block } = (
      await api("POST", "/api/objects", {
        payload: {
          presentAsMain: false,
          parentId: source,
          contentAst: [{ type: "mention", targetNodeId: target, text: "Target" }],
        },
      })
    ).json();

    const res = await api("GET", `/api/objects/${target}/backlinks`);
    expect(res.statusCode).toBe(200);
    const backlinks = res.json().backlinks;
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]).toMatchObject({ source_id: block, target_id: target, type: "mention" });
  });

  it("classes listing includes the seeded system classes", async () => {
    server = await makeTestServer();
    const res = await api("GET", "/api/classes");
    expect(res.statusCode).toBe(200);
    const classes = res.json().classes as { id: string; icon: string | null; memberCount: number }[];
    const byId = new Map(classes.map((c) => [c.id, c]));
    for (const expected of ["task", "day", "source", "collection", "whiteboard"] as const) {
      expect(byId.has(SYSTEM_CLASS_UUIDS[expected])).toBe(true);
    }
    const task = byId.get(SYSTEM_CLASS_UUIDS.task)!;
    expect(task.icon).toBe("mdiCheckboxMarkedCircleOutline");

    const detail = await api("GET", `/api/classes/${SYSTEM_CLASS_UUIDS.task}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().members).toEqual([]);
  });

  it("create with a class assignment shows up in class members", async () => {
    server = await makeTestServer();
    const { id } = (
      await api("POST", "/api/objects", {
        payload: { presentAsMain: true, name: "Task page", classIds: [SYSTEM_CLASS_UUIDS.task] },
      })
    ).json();
    const detail = (await api("GET", `/api/classes/${SYSTEM_CLASS_UUIDS.task}`)).json();
    expect(detail.members.map((m: { id: string }) => m.id)).toContain(id);
    const objects = (await api("GET", `/api/objects?class=${SYSTEM_CLASS_UUIDS.task}`)).json();
    expect(objects.objects.map((o: { id: string }) => o.id)).toContain(id);
  });

  it("create with isClass declares a class node (the class.create envelope)", async () => {
    server = await makeTestServer();
    const created = await api("POST", "/api/objects", { payload: { isClass: true, name: "Genre" } });
    expect(created.statusCode).toBe(201);
    const { id, object } = created.json();
    expect(object).toMatchObject({ id, isClass: true, presentAsMain: false, isActive: true });
    expect(object.name).toBe("Genre");

    // Classes are always roots: placement/render fields cannot accompany isClass.
    const withParent = await api("POST", "/api/objects", {
      payload: { isClass: true, name: "Nope", parentId: id },
    });
    expect(withParent.statusCode).toBe(422);
    const withClassIds = await api("POST", "/api/objects", {
      payload: { isClass: true, name: "Nope", classIds: [SYSTEM_CLASS_UUIDS.task] },
    });
    expect(withClassIds.statusCode).toBe(422);
  });

  it("PATCH presentAsMain toggles the render bit (promotion/demotion)", async () => {
    server = await makeTestServer();
    const { id: parent } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Host" } })).json();
    const { id: child } = (
      await api("POST", "/api/objects", { payload: { presentAsMain: false, name: "Child", parentId: parent } })
    ).json();
    expect((await api("GET", `/api/objects/${child}`)).json().object).toMatchObject({
      isClass: false,
      presentAsMain: false,
    });
    const patched = await api("PATCH", `/api/objects/${child}`, { payload: { presentAsMain: true } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().object.presentAsMain).toBe(true);
  });

  it("requires the API key on the object surface", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({ method: "GET", url: "/api/objects/anything" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("property values endpoint returns stored values", async () => {
    server = await makeTestServer();
    const { id } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Prop" } })).json();
    const isbnSchema = SYSTEM_PROPERTY_UUIDS.isbn;
    const env = newEnvelope({
      workspaceId: server.ctx.defaultWorkspace,
      actorId: "99999999-8888-4777-8666-555555555555",
      deviceId: "test",
      hlc: { physical: Date.now(), logical: 0 },
      opType: "property.set",
      payload: { objectId: id, propertySchemaId: isbnSchema, value: "978-3-16-148410-0", idx: 0 },
    });
    await server.app.inject({
      method: "POST",
      url: "/api/relay/v2/batch",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { envelopes: [env] },
    });
    const res = await api("GET", `/api/properties/${isbnSchema}/values`);
    expect(res.statusCode).toBe(200);
    // The values endpoint still selects the (retired) node.name column, so
    // objectName is null post-title-is-content; the stored value is the point.
    // Each entry carries the row's stable element id.
    expect(res.json().values).toEqual([
      {
        objectId: id,
        objectName: null,
        elementId: `${id}:${isbnSchema}:0`,
        idx: 0,
        value: "978-3-16-148410-0",
      },
    ]);
  });
});

describe("class membership endpoints", () => {
  it("PUT assigns idempotently; DELETE unassigns idempotently", async () => {
    server = await makeTestServer();
    const { id: classId } = (await api("POST", "/api/objects", { payload: { isClass: true, name: "Genre" } })).json();
    const { id } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Novel" } })).json();

    const assigned = await api("PUT", `/api/objects/${id}/classes/${classId}`);
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().object.classIds).toEqual([classId]);

    // OR-Set add-wins carrier: re-adding is an idempotent no-op.
    const again = await api("PUT", `/api/objects/${id}/classes/${classId}`);
    expect(again.statusCode).toBe(200);
    expect(again.json().object.classIds).toEqual([classId]);

    const removed = await api("DELETE", `/api/objects/${id}/classes/${classId}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().object.classIds).toEqual([]);

    // Removing an absent membership is an idempotent no-op tombstone.
    const againRemoved = await api("DELETE", `/api/objects/${id}/classes/${classId}`);
    expect(againRemoved.statusCode).toBe(200);
    expect(againRemoved.json().object.classIds).toEqual([]);
  });

  it("assign rejects class nodes, missing objects, and missing classes (fail loud)", async () => {
    server = await makeTestServer();
    const { id: classId } = (await api("POST", "/api/objects", { payload: { isClass: true, name: "Genre" } })).json();
    const { id: otherClassId } = (await api("POST", "/api/objects", { payload: { isClass: true, name: "Other" } })).json();

    // Class identity is the is_class bit — a class node is never a member.
    const classNode = await api("PUT", `/api/objects/${classId}/classes/${otherClassId}`);
    expect(classNode.statusCode).toBe(422);

    const missingObject = await api("PUT", `/api/objects/${crypto.randomUUID()}/classes/${classId}`);
    expect(missingObject.statusCode).toBe(404);

    const { id } = (await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Novel" } })).json();
    const missingClass = await api("PUT", `/api/objects/${id}/classes/${crypto.randomUUID()}`);
    expect(missingClass.statusCode).toBe(404);
  });
});

describe("class title derivation", () => {
  it("classes routes derive titles from the class node's content, not the registry cache", async () => {
    server = await makeTestServer();
    const { id: classId } = (await api("POST", "/api/objects", { payload: { isClass: true, name: "Migrated" } })).json();
    const { id: memberId } = (
      await api("POST", "/api/objects", { payload: { presentAsMain: true, name: "Member Page", classIds: [classId] } })
    ).json();

    // Simulate the pre-title-is-content migration drift: the registry cache
    // row is blank while the class node's content carries the title.
    const store = server.ctx.workspaces.storeFor(server.ctx.defaultWorkspace);
    store.database.prepare("UPDATE class SET name = '' WHERE id = ?").run(classId);

    const list = await api("GET", "/api/classes");
    expect(list.statusCode).toBe(200);
    const row = list.json().classes.find((entry: { id: string }) => entry.id === classId);
    expect(row.name).toBe("Migrated");
    expect(row.memberCount).toBe(1);

    const detail = await api("GET", `/api/classes/${classId}`);
    expect(detail.json().class.name).toBe("Migrated");
    expect(detail.json().members).toEqual([expect.objectContaining({ id: memberId, name: "Member Page" })]);

    // The embedded class summary on the object read derives the same way.
    const object = (await api("GET", `/api/objects/${memberId}`)).json().object;
    expect(object.classes).toEqual([expect.objectContaining({ id: classId, name: "Migrated" })]);
  });
});
