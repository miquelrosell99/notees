import { afterEach, describe, expect, it } from "vitest";
import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) { await closeTestServer(server); server = null; }
});

describe("read-later inbox bookkeeping", () => {
  it("remembers the collection id per workspace and defaults to undefined", async () => {
    server = await makeTestServer();
    const ws = server.ctx.defaultWorkspace;
    expect(server.ctx.auth.getReadLaterCollectionId(ws)).toBeUndefined();
    server.ctx.auth.setReadLaterCollectionId(ws, "11111111-2222-4333-8444-555555555555");
    expect(server.ctx.auth.getReadLaterCollectionId(ws)).toBe("11111111-2222-4333-8444-555555555555");
    // A second workspace is independent.
    server.ctx.auth.setReadLaterCollectionId("99999999-8888-4777-8666-555555555555", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(server.ctx.auth.getReadLaterCollectionId(ws)).toBe("11111111-2222-4333-8444-555555555555");
    // Upsert, not insert-once.
    server.ctx.auth.setReadLaterCollectionId(ws, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    expect(server.ctx.auth.getReadLaterCollectionId(ws)).toBe("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
  });
});
