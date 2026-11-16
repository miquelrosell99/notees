import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { isProxyPath } from "../src/word/proxy.js";
import { startWordServe, type WordServeSession } from "../src/word/serve.js";

const UPSTREAM_KEY = "secret-upstream-key";

// ---------------------------------------------------------------------------
// Test upstream: header echo, auth gate, SSE feed, request-body echo, and a
// minimal RFC6455 text-echo socket (test-only frame codec — the gateway
// tunnel never parses frames, so this also proves byte-level pass-through).
// ---------------------------------------------------------------------------

let upstream: Server;
let upstreamPort = 0;
const upgradeHeaders: Record<string, string>[] = [];

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function makeFrameParser(onFrame: (opcode: number, payload: Buffer) => void): (chunk: Buffer) => void {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0]! & 0x0f;
      const masked = (buf[1]! & 0x80) !== 0;
      let len = buf[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buf.length < offset + len) return;
      let payload = buf.subarray(offset, offset + len);
      if (masked) {
        payload = Buffer.from(payload);
        const mask = buf.subarray(maskOffset, maskOffset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
      }
      onFrame(opcode, payload);
      buf = buf.subarray(offset + len);
    }
  };
}

function startUpstream(): Promise<void> {
  upstream = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://upstream");
    if (url.pathname === "/api/echo-headers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
      return;
    }
    if (url.pathname === "/api/auth-gated") {
      if (req.headers["x-api-key"] !== UPSTREAM_KEY) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/echo-body") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      req.pipe(res);
      return;
    }
    if (url.pathname === "/api/sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: one\n\n");
      setTimeout(() => {
        res.write("data: two\n\n");
        setTimeout(() => res.end(), 50);
      }, 150);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  upstream.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://upstream");
    const headers: Record<string, string> = {};
    const raw = req.rawHeaders;
    for (let i = 0; i + 1 < raw.length; i += 2) headers[raw[i]!.toLowerCase()] = raw[i + 1]!;
    upgradeHeaders.push(headers);
    if (url.pathname !== "/api/relay/v2/ws/echo") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${headers["sec-websocket-key"]}${WS_GUID}`).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const parser = makeFrameParser((opcode, payload) => {
      if (opcode === 0x1) socket.write(encodeFrame(0x1, payload));
      else if (opcode === 0x9) socket.write(encodeFrame(0xa, payload));
      else if (opcode === 0x8) socket.end(encodeFrame(0x8, Buffer.alloc(0)));
    });
    socket.on("data", parser);
    if (head.length > 0) parser(head);
  });
  return new Promise((resolveListen) => {
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolveListen();
    });
  });
}

// ---------------------------------------------------------------------------
// Gateway fixture: vendored-statics shape + the proxy target.
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "notees-word-proxy-"));
const vendorWordDir = join(root, "vendor", "word");
const distDir = join(vendorWordDir, "dist");
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "index.html"), "<html><body>pane</body></html>");
writeFileSync(
  join(vendorWordDir, "manifest.xml"),
  '<OfficeApp><SourceLocation DefaultValue="${HOST}${BASE_PATH}/index.html"/></OfficeApp>',
);

const sessions: WordServeSession[] = [];
let cacheCounter = 0;

async function startGateway(): Promise<WordServeSession> {
  const session = await startWordServe({
    distDir,
    cacheDir: join(root, `cache-${cacheCounter++}`),
    port: 0,
    proxy: { upstream: `http://127.0.0.1:${upstreamPort}`, apiKey: UPSTREAM_KEY, workspaceId: "ws-from-cli" },
  });
  sessions.push(session);
  return session;
}

async function getJson(session: WordServeSession, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${session.port}${path}`, { headers });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(startUpstream, 30_000);

afterEach(async () => {
  while (sessions.length > 0) {
    await sessions.pop()!.close().catch(() => {});
  }
});

afterAll(async () => {
  await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
  rmSync(root, { recursive: true, force: true });
});

describe("isProxyPath", () => {
  it("proxies only /api/*", () => {
    expect(isProxyPath("/api/relay/v2/stats")).toBe(true);
    expect(isProxyPath("/api")).toBe(false);
    expect(isProxyPath("/apiary")).toBe(false);
    expect(isProxyPath("/")).toBe(false);
    expect(isProxyPath("/manifest.xml")).toBe(false);
  });
});

describe("word gateway /api proxy", () => {
  it("injects the configured key and drops client-supplied auth headers", async () => {
    const session = await startGateway();
    const { status, body } = await getJson(session, "/api/echo-headers", {
      "x-api-key": "evil-client-key",
      authorization: "Bearer evil",
      cookie: "session=evil",
      "x-custom": "pass-through",
    });
    expect(status).toBe(200);
    const headers = (body.headers ?? {}) as Record<string, string>;
    expect(headers["x-api-key"]).toBe(UPSTREAM_KEY);
    expect(headers["x-custom"]).toBe("pass-through");
    expect(headers["authorization"]).toBeUndefined();
    expect(headers["cookie"]).toBeUndefined();
  });

  it("is fixed-upstream: the client cannot retarget it (Host or otherwise)", async () => {
    const session = await startGateway();
    const { body } = await getJson(session, "/api/echo-headers", { host: "evil.example:9999" });
    const headers = (body.headers ?? {}) as Record<string, string>;
    expect(headers["host"]).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it("injects the configured workspace header only when the client sends none", async () => {
    const session = await startGateway();
    const injected = ((await getJson(session, "/api/echo-headers")).body.headers ?? {}) as Record<string, string>;
    expect(injected["x-workspace-id"]).toBe("ws-from-cli");
    const kept = ((await getJson(session, "/api/echo-headers", { "x-workspace-id": "ws-from-pane" })).body.headers ??
      {}) as Record<string, string>;
    expect(kept["x-workspace-id"]).toBe("ws-from-pane");
  });

  it("a gated upstream that 401s a direct call answers through the gateway", async () => {
    const direct = await fetch(`http://127.0.0.1:${upstreamPort}/api/auth-gated`);
    expect(direct.status).toBe(401);
    const session = await startGateway();
    const through = await fetch(`http://127.0.0.1:${session.port}/api/auth-gated`);
    expect(through.status).toBe(200);
    expect(((await through.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("streams long-lived responses chunk-for-chunk without buffering (SSE shape)", async () => {
    const session = await startGateway();
    const response = await fetch(`http://127.0.0.1:${session.port}/api/sse`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("content-length")).toBeNull(); // chunked relay
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe("data: one\n\n"); // "two" not buffered ahead
    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe("data: two\n\n");
  });

  it("relays request bodies (POST) without buffering", async () => {
    const session = await startGateway();
    const response = await fetch(`http://127.0.0.1:${session.port}/api/echo-body`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "streamed-request-body",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("streamed-request-body");
  });

  it("proxies WebSocket upgrades byte-for-byte with injected auth (relay socket path)", async () => {
    const session = await startGateway();
    // undici (runtime) accepts an options third argument for upgrade
    // headers; the DOM-flavored types stop at two — cast the constructor.
    const WS = WebSocket as unknown as new (
      url: string,
      protocols: string[],
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new WS(`ws://127.0.0.1:${session.port}/api/relay/v2/ws/echo?ticket=dummy`, [], {
      headers: { authorization: "Bearer evil", "x-api-key": "evil-client-key" },
    });
    try {
      const opened = await new Promise<string>((resolveOpen, rejectOpen) => {
        ws.addEventListener("open", () => resolveOpen("open"), { once: true });
        ws.addEventListener("error", () => rejectOpen(new Error("ws error")), { once: true });
      });
      expect(opened).toBe("open");
      ws.send("ping-through-the-tunnel");
      const echoed = await new Promise<string>((resolveMessage) => {
        ws.addEventListener("message", (event) => resolveMessage(String(event.data)), { once: true });
      });
      expect(echoed).toBe("ping-through-the-tunnel");
      const headers = upgradeHeaders.at(-1) ?? {};
      expect(headers["x-api-key"]).toBe(UPSTREAM_KEY);
      expect(headers["authorization"]).toBeUndefined();
      expect(headers["x-workspace-id"]).toBe("ws-from-cli");
      expect(headers["sec-websocket-key"]).toBeDefined(); // handshake preserved
    } finally {
      ws.close();
    }
  });

  it("statics and proxy coexist: / serves the pane, /api relays, other paths 404", async () => {
    const session = await startGateway();
    const index = await fetch(`http://127.0.0.1:${session.port}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("pane");
    const proxied = await fetch(`http://127.0.0.1:${session.port}/api/auth-gated`);
    expect(proxied.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${session.port}/nope`)).status).toBe(404);
  });
});
