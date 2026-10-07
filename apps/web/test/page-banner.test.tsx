/**
 * The page banner (the bannerAssetId wire field, object.update): a
 * full-width collapsible element above the header, inside the page card.
 * Collapsed to a slim strip by default (the per-page device-local pref);
 * expanding shows the fixed-height cover-fit image, or the dashed Add
 * affordance when no banner is set (the AssetUploadModal, images only).
 * Uploading sets the wire field; Remove clears it (present-null). Whiteboard
 * pages and embedded renders host no banner (the cover gating precedent).
 * The page context menu's Add banner rides the same upload modal. jsdom
 * over the in-process WorkspaceClient.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import {
  bannerAssetIdOf,
  clearNodeBanner,
  setNodeBanner,
} from "../src/ui/components/PageBanner.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
/** 64 hex chars — the protocol's content-hash shape. */
const HASH = "c3".repeat(32);

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** A plain page plus an asset-classed node with image bytes; returns both. */
async function seedPageAndAsset(client: WorkspaceClient): Promise<[string, string]> {
  const pageId = await client.createObject({ presentAsMain: true, name: "Bannered" });
  const assetId = await client.createObject({ presentAsMain: true, name: "wide.png" });
  await client.assignClass(assetId, SYSTEM_CLASS_UUIDS.asset);
  return [pageId, assetId];
}

describe("the page banner (the bannerAssetId wire field)", () => {
  it("reads through the ClientNode field; setNodeBanner writes the field + the asset class", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);

    await setNodeBanner(client, pageId, assetId);
    await flushWrites();

    expect(client.getNode(pageId)?.bannerAssetId).toBe(assetId);
    expect(bannerAssetIdOf(client, pageId)).toBe(assetId);
    expect(client.getNode(assetId)?.classIds).toContain(SYSTEM_CLASS_UUIDS.asset);

    await clearNodeBanner(client, pageId);
    await flushWrites();
    expect(client.getNode(pageId)?.bannerAssetId).toBeNull();
    expect(bannerAssetIdOf(client, pageId)).toBeNull();
    // The asset node survives the clear.
    expect(client.getNode(assetId)?.classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
  });

  it("renders collapsed by default; expanding shows the image", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,BANNER");
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeBanner(client, pageId, assetId);
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // Collapsed: the slim strip is the expand control, no image yet.
    const strip = screen.getByRole("button", { name: "Expand banner" });
    expect(strip.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".nt-bannercard__img")).toBeNull();

    fireEvent.click(strip);
    expect(screen.getByRole("button", { name: "Collapse banner" }).getAttribute("aria-expanded")).toBe("true");
    await flushWrites();
    expect(container.querySelector(".nt-bannercard__img")).not.toBeNull();
    // The banner spans the content width above the header row.
    const banner = container.querySelector(".nt-bannercard")!;
    const headerSection = container.querySelector(".page-header-section")!;
    expect(banner.compareDocumentPosition(headerSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the collapse pref is per-page and device-local (survives a remount)", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,PREFS");
    const [pageId, assetId] = await seedPageAndAsset(client);
    const [otherPageId] = await seedPageAndAsset(client);
    await setNodeBanner(client, pageId, assetId);
    await flushWrites();

    const first = render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand banner" }));
    await flushWrites();
    first.unmount();

    // A fresh mount of the same page reads the persisted pref: expanded.
    const second = render(<PageView client={client} pageId={pageId} />);
    expect(screen.getByRole("button", { name: "Collapse banner" })).not.toBeNull();
    second.unmount();

    // Another page is untouched (the pref is per-page): collapsed.
    render(<PageView client={client} pageId={otherPageId} />);
    expect(screen.getByRole("button", { name: "Expand banner" })).not.toBeNull();
  });

  it("the empty banner expands to the Add affordance; uploading sets the wire field", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,UPLOAD");
    const upload = vi.spyOn(client, "uploadAsset").mockResolvedValue({
      assetId: "0192a000-0000-7000-8000-0000000000b1",
      hash: HASH,
      mimeType: "image/png",
      size: 10,
      originalName: "uploaded.png",
    });
    const pageId = await client.createObject({ presentAsMain: true, name: "Unbannered" });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand banner" }));
    fireEvent.click(screen.getByRole("button", { name: "Add banner" }));
    const dialog = await screen.findByRole("dialog", { name: /upload file/i });

    // The banner flow is image-only.
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe("image/jpeg,image/png,image/webp");

    const file = new File(["bytes"], "uploaded.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await within(dialog).findAllByText("uploaded.png");
    fireEvent.click(within(dialog).getByRole("button", { name: /upload/i }));
    await flushWrites();

    expect(upload).toHaveBeenCalledWith(file, "uploaded.png");
    // The wire field carries the new asset node; the banner auto-expands.
    const bannerAssetId = client.getNode(pageId)?.bannerAssetId;
    expect(bannerAssetId).not.toBeNull();
    expect(client.getNode(bannerAssetId!)?.classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
    await screen.findByRole("button", { name: "Collapse banner" });
    await flushWrites();
    expect(container.querySelector(".nt-bannercard__img")).not.toBeNull();
  });

  it("Remove banner clears the wire field", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeBanner(client, pageId, assetId);
    await flushWrites();

    render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand banner" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove banner" }));
    await flushWrites();

    expect(client.getNode(pageId)?.bannerAssetId).toBeNull();
    // The empty affordance is back.
    expect(screen.getByRole("button", { name: "Add banner" })).not.toBeNull();
  });

  it("the page context menu offers Add banner, opening the same upload modal", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Menued" });
    await flushWrites();

    render(<PageView client={client} pageId={pageId} />);
    // Right-click the title (the page's node menu surface).
    fireEvent.contextMenu(containerTitle());
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Add banner" }));

    // The same image-only upload modal the empty affordance opens.
    const dialog = await screen.findByRole("dialog", { name: /upload file/i });
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe("image/jpeg,image/png,image/webp");
  });

  it("the menu item reads Change banner once a banner is set", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeBanner(client, pageId, assetId);
    await flushWrites();

    render(<PageView client={client} pageId={pageId} />);
    fireEvent.contextMenu(containerTitle());
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Change banner" })).not.toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Add banner" })).toBeNull();
  });

  it("whiteboard pages render no banner", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({
      presentAsMain: true,
      name: "Board",
      contentAst: [{ type: "whiteboard", layout: { cards: {}, shapes: [], strokes: [] } }],
    });
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(screen.queryByRole("button", { name: "Expand banner" })).toBeNull();
    expect(container.querySelector(".nt-bannercard")).toBeNull();
  });

  it("embedded renders show no banner", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeBanner(client, pageId, assetId);
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={pageId} embedded />);
    expect(screen.queryByRole("button", { name: "Expand banner" })).toBeNull();
    expect(container.querySelector(".nt-bannercard")).toBeNull();
  });
});

/** The page title wrap (the right-click menu surface). */
function containerTitle(): HTMLElement {
  return document.querySelector(".nt-page-title-wrap") as HTMLElement;
}
