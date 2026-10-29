// @vitest-environment node
/**
 * Snapshot upload transfer encoding: when CompressionStream exists (browsers,
 * Node 18+) `uploadSnapshot` gzips the body and sets Content-Encoding: gzip;
 * without it the body crosses as identity. Server-side negotiation is covered
 * by apps/server/test/relay-snapshot.test.ts — this seam asserts what the
 * transport actually puts on the wire via the injectable fetchImpl.
 */

import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { HttpTransport } from "../src/index.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  duplex?: string | undefined;
}

function stubFetch(captured: CapturedRequest): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    captured.url = String(url);
    captured.method = init?.method ?? "GET";
    captured.headers = new Headers(init?.headers);
    captured.body = init?.body ?? null;
    captured.duplex = (init as { duplex?: string } | undefined)?.duplex;
    return new Response(null, { status: 201 });
  }) as typeof fetch;
}

function makeTransport(fetchImpl: typeof fetch): HttpTransport {
  return new HttpTransport({
    baseUrl: "http://127.0.0.1:1",
    apiKey: "test-key",
    workspaceId: "0192a000-0000-7000-8000-000000000001",
    fetchImpl,
  });
}

const originalBytes = new Uint8Array([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9]);

describe("HttpTransport.uploadSnapshot — gzip Content-Encoding", () => {
  it("sends Content-Encoding: gzip and a body that gunzips to the original bytes when CompressionStream exists", async () => {
    const captured: CapturedRequest = { url: "", method: "", headers: new Headers(), body: null };
    const transport = makeTransport(stubFetch(captured));
    await transport.uploadSnapshot(originalBytes, { physical: 100, logical: 2 });

    expect(captured.method).toBe("PUT");
    expect(captured.url).toContain("/api/relay/v2/snapshot/data?workspaceId=");
    expect(captured.headers.get("content-type")).toBe("application/octet-stream");
    expect(captured.headers.get("content-encoding")).toBe("gzip");
    const sent = new Uint8Array(captured.body as ArrayBuffer);
    expect(gunzipSync(sent).equals(Buffer.from(originalBytes))).toBe(true);
  });

  it("falls back to identity when CompressionStream is unavailable", async () => {
    const real = globalThis.CompressionStream;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { CompressionStream?: unknown }).CompressionStream;
    try {
      const captured: CapturedRequest = { url: "", method: "", headers: new Headers(), body: null };
      const transport = makeTransport(stubFetch(captured));
      await transport.uploadSnapshot(originalBytes, { physical: 100, logical: 2 });

      expect(captured.headers.get("content-encoding")).toBeNull();
      expect(new Uint8Array(captured.body as ArrayBuffer)).toEqual(originalBytes);
    } finally {
      Object.defineProperty(globalThis, "CompressionStream", {
        writable: true,
        configurable: true,
        value: real,
      });
    }
  });
});

describe("HttpTransport.uploadSnapshotStream — lazy streaming gzip", () => {
  it("pipes the source through CompressionStream with duplex half; the captured body gunzips to the original", async () => {
    const captured: CapturedRequest = { url: "", method: "", headers: new Headers(), body: null };
    const transport = makeTransport(stubFetch(captured));
    await transport.uploadSnapshotStream({ physical: 100, logical: 2 }, () =>
      new Blob([originalBytes]).stream(),
    );

    expect(captured.method).toBe("PUT");
    expect(captured.url).toContain("/api/relay/v2/snapshot/data?workspaceId=");
    expect(captured.headers.get("content-encoding")).toBe("gzip");
    expect(captured.duplex).toBe("half");
    const stream = captured.body as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(gunzipSync(Buffer.concat(chunks.map((c) => Buffer.from(c)))).equals(Buffer.from(originalBytes))).toBe(true);
  });
});
