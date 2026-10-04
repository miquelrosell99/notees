import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("notees-fake-png-payload"),
]);

function multipartBody(bytes: Buffer, filename = "pixel.png", fields: Record<string, string> = {}): { payload: Buffer; contentType: string } {
  const boundary = "----noteestestboundary";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function upload(bytes: Buffer, filename?: string, fields?: Record<string, string>) {
  const { payload, contentType } = multipartBody(bytes, filename, fields);
  return server!.app.inject({
    method: "POST",
    url: "/api/assets",
    headers: { "content-type": contentType, ...server!.authHeaders },
    payload,
  });
}

function countAssetFiles(): number {
  const root = join(server!.dataDir, "workspaces");
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else count += 1;
    }
  };
  walk(root);
  return count;
}

describe("assets API", () => {
  it("upload → download round-trip", async () => {
    server = await makeTestServer();
    const up = await upload(PNG, "photo.png");
    expect(up.statusCode).toBe(201);
    const info = up.json();
    expect(info).toMatchObject({ mimeType: "image/png", size: PNG.length, refs: 1 });
    expect(info.assetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(info.hash).toMatch(/^[0-9a-f]{64}$/);

    const down = await server.app.inject({
      method: "GET",
      url: `/api/assets/${info.assetId}`,
      headers: server.authHeaders,
    });
    expect(down.statusCode).toBe(200);
    expect(down.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(down.rawPayload).equals(PNG)).toBe(true);
  });

  it("supports Range requests (206 + content-range)", async () => {
    server = await makeTestServer();
    const { assetId } = (await upload(PNG)).json();
    const res = await server.app.inject({
      method: "GET",
      url: `/api/assets/${assetId}`,
      headers: { ...server.authHeaders, range: "bytes=0-3" },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-3/${PNG.length}`);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(Buffer.from(res.rawPayload).equals(PNG.subarray(0, 4))).toBe(true);

    const tail = await server.app.inject({
      method: "GET",
      url: `/api/assets/${assetId}`,
      headers: { ...server.authHeaders, range: "bytes=4-" },
    });
    expect(tail.statusCode).toBe(206);
    expect(Buffer.from(tail.rawPayload).equals(PNG.subarray(4))).toBe(true);
  });

  it("dedupes identical bytes to one file with two refs", async () => {
    server = await makeTestServer();
    const first = await upload(PNG, "a.png");
    const second = await upload(PNG, "b.png");
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().hash).toBe(second.json().hash);
    expect(first.json().assetId).not.toBe(second.json().assetId);
    expect(countAssetFiles()).toBe(1);

    const info = (
      await server.app.inject({
        method: "GET",
        url: `/api/assets/${first.json().assetId}/info`,
        headers: server.authHeaders,
      })
    ).json();
    expect(info.refs).toBe(2);
  });

  it("rejects unknown magic bytes", async () => {
    server = await makeTestServer();
    const res = await upload(Buffer.from("plain text, no magic here"), "notes.txt");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("enforces the media size cap", async () => {
    server = await makeTestServer({ maxMediaBytes: 1024, maxDocumentBytes: 2048 });
    const oversized = Buffer.concat([PNG, Buffer.alloc(1500)]);
    const res = await upload(oversized, "big.png");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("size cap");
  });

  it("emits asset.attach when objectId is provided", async () => {
    server = await makeTestServer();
    const object = (
      await server.app.inject({
        method: "POST",
        url: "/api/objects",
        headers: { "content-type": "application/json", ...server.authHeaders },
        payload: { presentAsMain: true, name: "Attachment host" },
      })
    ).json();
    const up = await upload(PNG, "attached.png", { objectId: object.id });
    expect(up.statusCode).toBe(201);
    expect(up.json().objectId).toBe(object.id);

    const store = server.ctx.workspaces.storeFor(server.ctx.defaultWorkspace);
    const row = store.database
      .prepare("SELECT * FROM node_asset WHERE node_id = ?")
      .get(object.id) as { asset_id: string; hash: string; mime_type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.asset_id).toBe(up.json().assetId);
    expect(row!.mime_type).toBe("image/png");
  });

  it("parallel uploads with objectId: every attach lands (2026-10-04 incident)", async () => {
    server = await makeTestServer();
    const app = server.app;
    const headers = server.authHeaders;
    const store = server.ctx.workspaces.storeFor(server.ctx.defaultWorkspace);
    const targets = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const res = await app.inject({
          method: "POST",
          url: "/api/objects",
          headers: { "content-type": "application/json", ...headers },
          payload: { presentAsMain: true, name: "parallel host" },
        });
        return { i, id: (res.json() as { id: string }).id };
      }),
    );
    const results = await Promise.all(
      targets.map(async ({ i, id }) => {
        const up = await upload(PNG, `p${i}.png`, { objectId: id });
        return { id, status: up.statusCode, ack: (up.json() as { objectId?: string }).objectId };
      }),
    );
    for (const r of results) {
      expect(r.status).toBe(201);
      expect(r.ack).toBe(r.id);
    }
    for (const { id } of targets) {
      const row = store.database
        .prepare("SELECT asset_id FROM node_asset WHERE node_id = ?")
        .get(id) as { asset_id: string } | undefined;
      expect(row, `node_asset row for ${id}`).toBeDefined();
    }
  });

  it("serves bytes for a raw hash id and requires auth", async () => {
    server = await makeTestServer();
    const { hash } = (await upload(PNG)).json();
    const byHash = await server.app.inject({
      method: "GET",
      url: `/api/assets/${hash}`,
      headers: server.authHeaders,
    });
    expect(byHash.statusCode).toBe(200);
    expect(Buffer.from(byHash.rawPayload).equals(PNG)).toBe(true);

    const unauthenticated = await server.app.inject({ method: "GET", url: `/api/assets/${hash}` });
    expect(unauthenticated.statusCode).toBe(401);

    const missing = await server.app.inject({
      method: "GET",
      url: `/api/assets/${crypto.randomUUID()}`,
      headers: server.authHeaders,
    });
    expect(missing.statusCode).toBe(404);
  });

  it("stores bytes at <dataDir>/workspaces/<ws>/assets/<hash[:4]>/<hash>", async () => {
    server = await makeTestServer();
    const { hash } = (await upload(PNG)).json();
    const path = join(
      server.dataDir,
      "workspaces",
      server.ctx.defaultWorkspace,
      "assets",
      hash.slice(0, 4),
      hash,
    );
    expect(statSync(path).isFile()).toBe(true);
    expect(readFileSync(path).equals(PNG)).toBe(true);
  });
});
