/**
 * Presentation mode integration tests — DeckView over a real
 * seeded client: the title slide, the intro/section partition rendered
 * read-only, keymap navigation, Esc exit, session-local resume, link
 * click-through (exit + navigate), embed expansion into the slide stream,
 * and the page-menu "Present" entry point.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { DeckView } from "../src/ui/presentation/DeckView.js";
import { clearAllResumeIndexes } from "../src/ui/presentation/presentationSession.js";
import { NodeMenuButton } from "../src/ui/components/NodeMenuButton.js";
import { ensureCoverProperty } from "../src/ui/components/coverProperty.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  clearAllResumeIndexes();
  vi.restoreAllMocks();
});

async function seedClient(relay: MemoryRelay = new MemoryRelay()): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(relay),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const counter = () => document.body.querySelector(".presentation-overlay__counter")?.textContent;

/** Page + one intro block + two sections (the canonical deck shape). */
async function seedDeckFixture(client: WorkspaceClient) {
  const pageId = await client.createObject({ presentAsMain: true, name: "Quarterly Review" });
  await client.createObject({
    parentId: pageId,
    presentAsMain: false,
    contentAst: [{ type: "text", text: "An opening thought" }],
  });
  const sectionA = await client.createObject({ parentId: pageId, presentAsMain: true, name: "Section A" });
  await client.createObject({
    parentId: sectionA,
    contentAst: [{ type: "text", text: "Body of section A" }],
  });
  const sectionB = await client.createObject({ parentId: pageId, presentAsMain: true, name: "Section B" });
  await client.createObject({
    parentId: sectionB,
    contentAst: [{ type: "text", text: "Body of section B" }],
  });
  return { pageId, sectionA, sectionB };
}

describe("DeckView", () => {
  it("opens on the title slide and decks title + intro + sections in order", async () => {
    const client = await seedClient();
    const { pageId } = await seedDeckFixture(client);
    render(<DeckView client={client} pageId={pageId} onOpenNode={() => {}} onClose={() => {}} />);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(counter()).toBe("1 / 4");
    expect(document.body.querySelector(".nt-deck-title")?.textContent).toBe("Quarterly Review");

    press("ArrowRight");
    expect(counter()).toBe("2 / 4");
    expect(screen.getByText("An opening thought")).toBeTruthy();

    press("ArrowRight");
    expect(counter()).toBe("3 / 4");
    expect(screen.getByText("Section A")).toBeTruthy();
    expect(screen.getByText("Body of section A")).toBeTruthy();

    press("ArrowRight");
    expect(counter()).toBe("4 / 4");
    expect(screen.getByText("Section B")).toBeTruthy();
    expect(screen.getByText("Body of section B")).toBeTruthy();
  });

  it("Esc exits; reopening the same page resumes at the remembered slide", async () => {
    const client = await seedClient();
    const { pageId } = await seedDeckFixture(client);
    const onClose = vi.fn();
    const first = render(<DeckView client={client} pageId={pageId} onOpenNode={() => {}} onClose={onClose} />);
    press("ArrowRight");
    press("ArrowRight");
    expect(counter()).toBe("3 / 4");

    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    render(<DeckView client={client} pageId={pageId} onOpenNode={() => {}} onClose={() => {}} />);
    expect(counter()).toBe("3 / 4");
    expect(screen.getByText("Section A")).toBeTruthy();
  });

  it("link click-through exits the deck and navigates", async () => {
    const client = await seedClient();
    const { pageId, sectionA } = await seedDeckFixture(client);
    const targetId = await client.createObject({ presentAsMain: true, name: "Linked Target" });
    await client.createObject({
      parentId: sectionA,
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Linked Target" }],
    });

    const onClose = vi.fn();
    const onOpenNode = vi.fn();
    render(<DeckView client={client} pageId={pageId} onOpenNode={onOpenNode} onClose={onClose} />);
    press("ArrowRight");
    press("ArrowRight");
    // Slide 3 = Section A: title + nested children (body + mention).
    expect(counter()).toBe("3 / 4");

    fireEvent.click(screen.getByRole("button", { name: "Linked Target" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenNode).toHaveBeenCalledWith(targetId);
  });

  it("expands an embed_ref target's children into the slide stream after the referencing slide", async () => {
    const client = await seedClient();
    const targetId = await client.createObject({ presentAsMain: true, name: "Embedded Deck" });
    await client.createObject({ parentId: targetId, presentAsMain: true, name: "Embedded Section" });
    await client.createObject({
      parentId: targetId,
      presentAsMain: false,
      contentAst: [{ type: "text", text: "Embedded intro" }],
    });

    const pageId = await client.createObject({ presentAsMain: true, name: "Host Deck" });
    const host = await client.createObject({ parentId: pageId, presentAsMain: true, name: "Host Section" });
    await client.createObject({
      parentId: host,
      contentAst: [{ type: "embed_ref", nodeId: targetId }],
    });

    render(<DeckView client={client} pageId={pageId} onOpenNode={() => {}} onClose={() => {}} />);
    expect(counter()).toBe("1 / 4");

    press("ArrowRight");
    expect(screen.getByText("Host Section")).toBeTruthy();
    // The embed box renders inside the referencing slide (the live-subtree
    // embed rule is untouched — expansion ADDS slides, replaces nothing).
    expect(document.body.querySelector(".nt-embed")).not.toBeNull();

    press("ArrowRight");
    expect(screen.getByText("Embedded Section")).toBeTruthy();

    press("ArrowRight");
    expect(screen.getByText("Embedded intro")).toBeTruthy();
    expect(counter()).toBe("4 / 4");
  });

  it("stays read-only: body text renders without the editor and toggles nothing", async () => {
    const client = await seedClient();
    const { pageId, sectionA } = await seedDeckFixture(client);
    await client.createObject({
      parentId: sectionA,
      contentAst: [{ type: "text", text: "Checkbox row" }],
      classIds: [],
    });

    render(<DeckView client={client} pageId={pageId} onOpenNode={() => {}} onClose={() => {}} />);
    press("ArrowRight");
    press("ArrowRight");
    // No contentEditable anywhere in the deck: the read-only contract.
    expect(document.body.querySelector(".presentation-overlay [contenteditable]")).toBeNull();
    // The underlying block is untouched by the deck session.
    const block = client.getBlockTree(sectionA);
    expect(block[0]!.node.contentAst).toEqual([{ type: "text", text: "Body of section A" }]);
  });

  it("routes a table-classed block through the BlockRow grid instead of flattening it", async () => {
    const client = await seedClient();
    // A body section holding a table container (rows × cells).
    const pageId = await client.createObject({ presentAsMain: true, name: "Table Deck" });
    const { ensureTableFamily } = await import("../src/ui/components/tableFamily.js");
    const tableClassId = await ensureTableFamily(client);
    const holder = await client.createObject({ parentId: pageId, presentAsMain: false, contentAst: [] });
    const containerId = await client.createObject({ parentId: holder, classIds: [tableClassId] });
    const row1 = await client.createObject({ parentId: containerId });
    const c11 = await client.createObject({ parentId: row1, contentAst: [{ type: "text", text: "alpha" }] });
    await client.createObject({ parentId: row1, contentAst: [{ type: "text", text: "beta" }] });
    const row2 = await client.createObject({ parentId: containerId });
    await client.createObject({ parentId: row2, contentAst: [{ type: "text", text: "gamma" }] });
    await client.createObject({ parentId: row2, contentAst: [{ type: "text", text: "delta" }] });
    void c11;

    render(<DeckView client={client} pageId={pageId} onOpenNode={() => {}} onClose={() => {}} />);
    // Slide 2 = the intro run holding the holder → the table grid renders
    // through the BlockRow branch (not a flattened list of rows/cells).
    press("ArrowRight");
    const overlay = document.body.querySelector(".presentation-overlay")!;
    const grid = overlay.querySelector(".nt-blocktable");
    expect(grid).not.toBeNull();
    expect(grid!.querySelectorAll(".nt-blocktable-row")).toHaveLength(2);
    expect(overlay.querySelector(".nt-blocktable")!.textContent).toContain("alpha");
    expect(overlay.querySelector(".nt-blocktable")!.textContent).toContain("delta");
    // Read-only: the table toolbar (mutation gestures) stays out of the deck.
    expect(overlay.querySelector(".nt-table-toolbar")).toBeNull();
  });
});

describe("Present entry point", () => {
  it("the node menu button offers Present and requests a deck of the page", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Deckable" });
    const node = client.getNode(pageId);
    expect(node).toBeDefined();

    const onPresent = vi.fn();
    render(<NodeMenuButton client={client} node={node!} onOpenNode={() => {}} onPresent={onPresent} />);
    fireEvent.click(screen.getByRole("button", { name: "Node actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Present" }));
    expect(onPresent).toHaveBeenCalledWith(pageId);
  });

  it("the node menu hides Present when the host has no deck surface", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Deckable" });
    const node = client.getNode(pageId)!;

    render(<NodeMenuButton client={client} node={node} onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Node actions" }));
    expect(screen.queryByRole("menuitem", { name: "Present" })).toBeNull();
  });
});

describe("DeckView — assets, images, and covers in presentation mode", () => {
  it("an asset token inside a text block renders the live image (click → lightbox)", async () => {
    const client = await seedClient();
    const asset = await client.createObject({ presentAsMain: true, name: "slide-art.png" });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);
    vi.spyOn(client, "getAssetInfo").mockReturnValue({
      assetId: asset,
      mimeType: "image/png",
      originalName: "slide-art.png",
      size: 10,
      hash: "hash-slide",
      uploadedAt: "2026-10-04T00:00:00Z",
    });
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,SLIDE");

    const pageId = await client.createObject({ presentAsMain: true, name: "Asset Deck" });
    await client.createObject({
      parentId: pageId,
      presentAsMain: false,
      contentAst: [
        { type: "text", text: "Look at this" },
        { type: "asset_ref", assetId: asset },
      ],
    });

    render(<DeckView client={client} pageId={pageId} onOpenNode={() => {}} onClose={() => {}} />);
    press("ArrowRight");
    // The asset image resolves asynchronously (bytes → data URL).
    await screen.findByAltText("slide-art.png");
    const overlay = document.body.querySelector(".presentation-overlay")!;
    expect(overlay.querySelector(".nt-asset--image img")).not.toBeNull();
    fireEvent.click(overlay.querySelector(".nt-asset--image")!);
    expect(document.body.querySelector(".image-modal-image")).not.toBeNull();
  });

  it("the presented page's cover renders as the title slide's hero", async () => {
    const client = await seedClient();
    await ensureCoverProperty(client);
    const coverAsset = await client.createObject({ presentAsMain: true, name: "hero.png" });
    await client.assignClass(coverAsset, SYSTEM_CLASS_UUIDS.asset);
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,HERO");

    const pageId = await client.createObject({ presentAsMain: true, name: "Covered Deck" });
    await client.setProperty(pageId, SYSTEM_PROPERTY_UUIDS.cover, { nodeId: coverAsset }, 0);

    render(<DeckView client={client} pageId={pageId} onOpenNode={() => {}} onClose={() => {}} />);
    await act(async () => {});
    const cover = document.body.querySelector(".nt-deck-cover .nt-deck-image");
    expect(cover).not.toBeNull();
    expect(document.body.querySelector(".nt-deck-title")?.textContent).toBe("Covered Deck");
  });

  it("a section with a cover but no image block gets the cover in the right column, text intact", async () => {
    const client = await seedClient();
    await ensureCoverProperty(client);
    const coverAsset = await client.createObject({ presentAsMain: true, name: "section.png" });
    await client.assignClass(coverAsset, SYSTEM_CLASS_UUIDS.asset);
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,SECTION");

    const pageId = await client.createObject({ presentAsMain: true, name: "Section Cover Deck" });
    const section = await client.createObject({ parentId: pageId, presentAsMain: true, name: "Covered Section" });
    await client.setProperty(section, SYSTEM_PROPERTY_UUIDS.cover, { nodeId: coverAsset }, 0);
    await client.createObject({
      parentId: section,
      contentAst: [
        { type: "text", text: "First paragraph" },
        { type: "text", text: "Second paragraph" },
      ],
    });

    render(<DeckView client={client} pageId={pageId} onOpenNode={() => {}} onClose={() => {}} />);
    press("ArrowRight");
    await act(async () => {});
    const overlay = document.body.querySelector(".presentation-overlay")!;
    // The cover-split: columns with the image right…
    expect(overlay.querySelector(".nt-deck-columns .nt-deck-image-column .nt-deck-image")).not.toBeNull();
    // …and BOTH text paragraphs still in the text column (cover-split drops
    // nothing — unlike the trailing-image split).
    expect(overlay.querySelector(".nt-deck-body")!.textContent).toContain("First paragraph");
    expect(overlay.querySelector(".nt-deck-body")!.textContent).toContain("Second paragraph");
  });
});
