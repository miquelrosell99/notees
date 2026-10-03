/**
 * Presentation mode integration tests (§34.26 P3–P7) — DeckView over a real
 * seeded client: the title slide, the intro/section partition rendered
 * read-only, keymap navigation, Esc exit, session-local resume, link
 * click-through (exit + navigate), embed expansion into the slide stream,
 * and the page-menu "Present" entry point.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { DeckView } from "../src/ui/presentation/DeckView.js";
import { clearAllResumeIndexes } from "../src/ui/presentation/presentationSession.js";
import { NodeMenuButton } from "../src/ui/components/NodeMenuButton.js";

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
