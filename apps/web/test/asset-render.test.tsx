/**
 * Asset renderer tests (§34.34 BB1 — SCHEMA.md:61): an `asset_ref` token
 * renders inline (image preview when the bytes are image-like, filename +
 * size chip otherwise) or full-bleed when it is alone in its stream; the
 * image click opens the ImageModal lightbox; a non-image chip downloads via
 * the CAS read; an unknown asset keeps the dashed placeholder box. jsdom
 * over the in-process WorkspaceClient with a stubbed fetch + REST config.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const SERVER = "https://notees.test";
const API_KEY = "test-api-key";
/** Distinct CAS ids per test — the image cache is per-id for the session. */
const PDF_ASSET = "0192a000-0000-7000-8000-0000000000a1";
const IMAGE_ASSET = "0192a000-0000-7000-8000-0000000000a2";
const LONE_PDF_ASSET = "0192a000-0000-7000-8000-0000000000a3";
const MISSING_ASSET = "0192a000-0000-7000-8000-0000000000a4";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
    serverUrl: SERVER,
    apiKey: API_KEY,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

function stubFetch(): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("file-bytes", { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

function stubObjectUrls(): void {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => "blob:notees-test",
    revokeObjectURL: () => {},
  });
}

describe("asset_ref renderer (BB1)", () => {
  it("renders a non-image asset inline as a filename + size chip that downloads on click", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Assets" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "see " }, { type: "asset_ref", assetId: PDF_ASSET }],
    });
    await client.attachAsset(pageId, {
      assetId: PDF_ASSET,
      hash: "a1".repeat(32),
      mimeType: "application/pdf",
      size: 2048,
      originalName: "paper.pdf",
    });
    const calls = stubFetch();
    stubObjectUrls();

    render(<PageView client={client} pageId={pageId} />);

    const chip = screen.getByRole("button", { name: /paper\.pdf/ });
    expect(chip.className).toContain("nt-asset--chip");
    // Inline (not alone in the stream): no full-bleed variant.
    expect(chip.className).not.toContain("nt-asset--fullbleed");
    expect(chip.textContent).toContain("2.0 KB");

    fireEvent.click(chip);
    await waitFor(() => {
      const download = calls.find((c) => c.url === `${SERVER}/api/assets/${PDF_ASSET}`);
      expect(download).toBeDefined();
      expect((download!.init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY);
    });
  });

  it("renders a lone asset_ref full-bleed", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Lone Asset" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "asset_ref", assetId: LONE_PDF_ASSET }],
    });
    await client.attachAsset(pageId, {
      assetId: LONE_PDF_ASSET,
      hash: "b2".repeat(32),
      mimeType: "application/pdf",
      size: 5,
      originalName: "scan.pdf",
    });
    stubFetch();
    stubObjectUrls();

    render(<PageView client={client} pageId={pageId} />);

    const chip = screen.getByRole("button", { name: /scan\.pdf/ });
    expect(chip.className).toContain("nt-asset--fullbleed");
  });

  it("renders an image preview and opens the ImageModal lightbox on click", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Image Block" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "asset_ref", assetId: IMAGE_ASSET }],
    });
    await client.attachAsset(pageId, {
      assetId: IMAGE_ASSET,
      hash: "c3".repeat(32),
      mimeType: "image/png",
      size: 100,
      originalName: "photo.png",
    });
    // jsdom can't run the fetch → blob → FileReader byte path (the export
    // suite spies the same cached read); the renderer's job — swap the chip
    // for the preview once the data URL resolves — is what's under test.
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,aGk=");

    const { container } = render(<PageView client={client} pageId={pageId} />);

    // The bytes resolve async through the cached data-URL read; the lone
    // token renders full-bleed. Wait for the image variant specifically (the
    // chip is the loading/fallback state).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /photo\.png/ }).className).toContain(
        "nt-asset--image",
      ),
    );
    const preview = screen.getByRole("button", { name: /photo\.png/ });
    expect(preview.className).toContain("nt-asset--fullbleed");
    expect(preview.querySelector("img")).not.toBeNull();
    expect(container.querySelector(".image-modal-backdrop")).toBeNull();

    fireEvent.click(preview);
    const backdrop = await screen.findByRole("button", { name: "Close (Esc)" });
    expect(backdrop.closest(".image-modal-backdrop")).not.toBeNull();

    fireEvent.click(backdrop);
    await waitFor(() => expect(document.querySelector(".image-modal-backdrop")).toBeNull());
  });

  it("keeps the placeholder box for an unknown asset id", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Missing" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "asset_ref", assetId: MISSING_ASSET }],
    });

    render(<PageView client={client} pageId={pageId} />);

    // Broken-mention philosophy: the dashed box names the token, the raw id
    // rides the title — and no fetch is attempted.
    const placeholder = screen.getByText("asset");
    expect(placeholder.className).toContain("nt-placeholder");
    expect(placeholder.getAttribute("title")).toBe(MISSING_ASSET);
  });
});
