// @vitest-environment node
/**
 * Key-in-fragment share publishing tests (plan 08): the artifact layout is
 * iv(12) ‖ tag(16) ‖ ct (b64u), the key never reaches the publish routes,
 * and the returned link pins the #fragment.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { b64uDecode, b64uEncode } from "@notees/protocol";

import {
  publishSealedShare,
  sealShareHtml,
} from "../src/features/sharing/sealShare.js";

const SERVER = "https://notees.example.com";
const HTML = new TextEncoder().encode("<html><body><h1>Quarterly plan</h1><p>secret body</p></body></html>");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sealShareHtml", () => {
  it("seals and reopens: artifact layout iv(12) ‖ tag(16) ‖ ct, b64u round-trip via WebCrypto", async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const { artifact, keyBytes: used } = await sealShareHtml(HTML, keyBytes);
    expect(used).toBe(keyBytes);
    const raw = b64uDecode(artifact);
    expect(raw.length).toBe(12 + 16 + HTML.length);
    // Reopen through the viewer's split: iv = [0,12), tag = [12,28), ct = [28,).
    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const ct = raw.slice(28);
    const sealed = new Uint8Array(ct.length + tag.length);
    sealed.set(ct, 0);
    sealed.set(tag, ct.length);
    const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, sealed as BufferSource);
    expect(new TextDecoder().decode(plain)).toBe(new TextDecoder().decode(HTML));
  });
});

describe("publishSealedShare", () => {
  it("mints, renders, and PUTs CIPHERTEXT ONLY; the link pins the #fragment key", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET", body: (init?.body as string) ?? null });
        if (url.endsWith("/api/shares") && (init?.method ?? "GET") === "POST") {
          return Response.json({
            share: {
              token: "tok_sealed_000000000000000000000",
              urlPath: "/s/tok_sealed_000000000000000000000",
              nodeId: "page-1",
              workspaceId: "ws1",
              createdBy: null,
              createdAt: 1,
              expiresAt: null,
              revokedAt: null,
            },
          });
        }
        if (url.endsWith("/artifact")) return new Response(null, { status: 204 });
        return new Response("unexpected", { status: 500 });
      }),
    );

    const fakeClient = {} as never; // render is injected — the client never touches the store here
    const sealed = await publishSealedShare(fakeClient, SERVER, "session-token", "page-1", async () => HTML);

    // The URL carries the fragment; the key is b64u 32 bytes.
    expect(sealed.url).toMatch(/^https:\/\/notees\.example\.com\/s\/tok_sealed_[A-Za-z0-9_-]+#[A-Za-z0-9_-]{43}$/);
    expect(b64uDecode(sealed.url.split("#")[1]!).length).toBe(32);

    // The artifact PUT carried ONLY the ciphertext: no HTML marker, no key.
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`${SERVER}/api/shares/tok_sealed_000000000000000000000/artifact`);
    const body = JSON.parse(put.body!) as { ciphertext: string };
    expect(body.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.ciphertext).not.toContain("Quarterly plan");
    expect(body.ciphertext).not.toContain(b64uEncode(sealed.keyBytes));
    expect(Object.keys(body)).toEqual(["ciphertext"]);
  });
});
