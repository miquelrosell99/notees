/**
 * Rendering tests: PageView over a locally-seeded store (via the client,
 * MemoryRelay transport). jsdom environment.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, screen, within, fireEvent, act } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  // Explicit wasm path so this works under jsdom too (sql.js falls back to
  // fs-based loading when the path is absolute).
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
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

describe("PageView rendering", () => {
  it("renders text marks, mention, typed link, quote, and hard break", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({
      isEmbedded: false,
      name: "Render Me",
    });
    const targetPageId = await client.createObject({
      isEmbedded: false,
      name: "Mention Target",
    });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "plain " },
        { type: "text", text: "bold part", marks: ["bold"] },
        { type: "text", text: " and " },
        { type: "text", text: "italic part", marks: ["italic"] },
        { type: "hard_break" },
        { type: "mention", targetNodeId: targetPageId, text: "Mention Target" },
        { type: "typed_link", verb: "cites", text: "Kuhn" },
        { type: "quote", children: [{ type: "text", text: "quoted words" }] },
      ],
    });
    const nestedParent = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "parent" }],
    });
    await client.createObject({
      parentId: nestedParent,
      contentAst: [{ type: "text", text: "nested child" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);

    // Header uses the stored name.
    expect(screen.getByRole("heading", { name: "Render Me" })).toBeInTheDocument();

    // Marks (scoped to the block tree — Linked references may echo a block
    // that mentions this page).
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    expect(within(tree).getByText("bold part").tagName).toBe("STRONG");
    expect(within(tree).getByText("italic part").tagName).toBe("EM");

    // Hard break.
    expect(tree.querySelector("br")).not.toBeNull();

    // Mention renders as a clickable dashed-underline link resolving the
    // target's current name.
    const mention = within(tree).getByText("Mention Target");
    expect(mention.className).toContain("nt-link");
    expect(mention.tagName).toBe("BUTTON");

    // Typed link: underlined span carrying the verb as its title.
    const typedLink = within(tree).getByText("Kuhn");
    expect(typedLink.className).toContain("nt-typed-link");
    expect(typedLink.getAttribute("title")).toBe("cites");

    // Quote renders its children recursively inside the quote style.
    expect(within(tree).getByText("quoted words")).not.toBeNull();
    expect(tree.querySelector(".nt-quote")).not.toBeNull();

    // Nested child renders inside the indented children container.
    expect(within(tree).getByText("nested child")).not.toBeNull();
    expect(tree.querySelector(".nt-block-children")).not.toBeNull();

    // Unknown token types never crash the renderer. (Scoped to the tree:
    // the context column's TOC lists the one-line text too.)
    await client.updateObject(nestedParent, {
      contentAst: [
        { type: "text", text: "parent" },
        { type: "future_token_v99", payload: { x: 1 } },
      ] as unknown as ContentAst,
    });
    expect(within(tree).getByText("parent")).not.toBeNull();
  });

  it("mentions render the linked node's defined effective icon ahead of the label", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Icons" });
    // The target carries its own icon (the header "Add icon" flow writes
    // object.update — object.create does not carry icon).
    const iconTargetId = await client.createObject({
      isEmbedded: false,
      name: "Iconed Target",
    });
    await client.updateObject(iconTargetId, { icon: "mdi-account" });
    // The class-icon path: no own icon, but a class with one.
    const classId = await client.createClass("Iconed Class", { icon: "mdi-briefcase" });
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Iconed Class" }] });
    const classTargetId = await client.createObject({
      isEmbedded: false,
      name: "Class Iconed Target",
      classIds: [classId],
    });
    // An iconless target stays text-only.
    const plainTargetId = await client.createObject({ isEmbedded: false, name: "Plain Target" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "mention", targetNodeId: iconTargetId, text: "Iconed Target" },
        { type: "text", text: " " },
        { type: "mention", targetNodeId: classTargetId, text: "Class Iconed Target" },
        { type: "text", text: " " },
        { type: "mention", targetNodeId: plainTargetId, text: "Plain Target" },
      ],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;

    // Exactly the two icon-bearing targets wear the icon (owner 2026-10-17:
    // the defined effective icon only — no display-default glyph).
    const icons = tree.querySelectorAll(".nt-link__icon");
    expect(icons).toHaveLength(2);
    expect(within(tree).getByText("Iconed Target").querySelector(".nt-link__icon")).not.toBeNull();
    expect(within(tree).getByText("Class Iconed Target").querySelector(".nt-link__icon")).not.toBeNull();
    expect(within(tree).getByText("Plain Target").querySelector(".nt-link__icon")).toBeNull();
  });

  it("renders placeholder boxes for block-scale tokens", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Placeholders" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        // Unknown asset (no node_asset row): the asset renderer's own
        // broken-asset fallback draws the dashed box (BB1).
        { type: "asset_ref", assetId: "0192a000-0000-7000-8000-0000000000a1" },
        { type: "embed_ref", nodeId: "0192a000-0000-7000-8000-0000000000a2" },
        { type: "query", queryAst: { all: true } },
        { type: "whiteboard", layout: {} },
        { type: "math", expression: "E = mc^2" },
        { type: "external_link", href: "https://example.com", text: "Example" },
      ],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);

    expect(screen.getByText("asset")).not.toBeNull();
    // embed_ref resolves live when a renderer is present; this target does not
    // exist, so the broken-embed placeholder shows with the raw id visible.
    expect(screen.getByText(/broken embed/)).not.toBeNull();
    expect(screen.getByText("0192a000-0000-7000-8000-0000000000a2")).not.toBeNull();
    // The query token renders live (QueryBlockView): a malformed AST shows
    // the "invalid query" placeholder, never a crash.
    expect(screen.getByText("invalid query")).not.toBeNull();
    // The whiteboard token renders live too (WhiteboardCanvas, embedded
    // mini-canvas); the asset_ref above renders via AssetView's unknown-asset
    // fallback — known assets render as chips/previews (asset-render.test).
    expect(container.querySelector(".nt-wb-embedded")).not.toBeNull();
    expect(screen.getByText("E = mc^2").tagName).toBe("CODE");
    const link = screen.getByText("Example");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.com");
    // An external link is a plain hyperlink, not a chip: the hyperlink class
    // and none of the chip chrome.
    expect(link.classList.contains("nt-hyperlink")).toBe(true);
    expect(link.classList.contains("nt-chip")).toBe(false);
  });

  it("a class_link whose class was DELETED renders pending; clicking re-assigns", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Divergence" });
    const classId = await client.createClass("correo");
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "class_link", classId }],
    });
    // The content assertion assigned the class at create — and class.unassign
    // refuses while the content references it, so the ONLY reachable
    // divergence is a deleted class: the delete sweeps memberships, the
    // content link remains.
    expect(client.getNode(blockId)?.classIds).toEqual([classId]);
    await client.deleteObject(classId); // trash: the class-delete sweep clears memberships, the content link remains

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;

    // Legal, visible: dashed pending underline, assign tooltip.
    const link = tree.querySelector(".nt-link--class-pending") as HTMLElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("title")).toContain("not assigned");

    // One click assigns the class back onto the node.
    fireEvent.click(link);
    await act(async () => {});
    expect(client.getNode(blockId)?.classIds).toEqual([classId]);
  });

  it("an inline class link whose class IS assigned renders live (solid)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Converged" });
    const classId = await client.createClass("correo");
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "class_link", classId }],
    });
    await client.assignClass(blockId, classId);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const tree = container.querySelector(".nt-block-tree") as HTMLElement;
    const link = within(tree).getByText("correo");
    expect(link.className).toContain("nt-link--class");
    expect(link.className).not.toContain("nt-link--class-pending");
  });
});
