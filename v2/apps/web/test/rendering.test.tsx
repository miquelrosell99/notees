/**
 * Rendering tests: PageView over a locally-seeded store (via the client,
 * MemoryRelay transport). jsdom environment.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, screen } from "@testing-library/react";

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
      nodeType: "page",
      name: "Render Me",
    });
    const targetPageId = await client.createObject({
      nodeType: "page",
      name: "Mention Target",
    });
    await client.createObject({
      nodeType: "block",
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
      nodeType: "block",
      parentId: pageId,
      contentAst: [{ type: "text", text: "parent" }],
    });
    await client.createObject({
      nodeType: "block",
      parentId: nestedParent,
      contentAst: [{ type: "text", text: "nested child" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);

    // Header uses the stored name.
    expect(screen.getByRole("heading", { name: "Render Me" })).toBeInTheDocument();

    // Marks.
    expect(screen.getByText("bold part").tagName).toBe("STRONG");
    expect(screen.getByText("italic part").tagName).toBe("EM");

    // Hard break.
    expect(container.querySelector("br")).not.toBeNull();

    // Mention chip resolves the target's current name.
    const mention = screen.getByText("Mention Target");
    expect(mention.className).toContain("nt-mention");

    // Typed link: underlined span carrying the verb as its title.
    const typedLink = screen.getByText("Kuhn");
    expect(typedLink.className).toContain("nt-typed-link");
    expect(typedLink.getAttribute("title")).toBe("cites");

    // Quote renders its children recursively inside the quote style.
    expect(screen.getByText("quoted words")).not.toBeNull();
    expect(container.querySelector(".nt-quote")).not.toBeNull();

    // Nested child renders inside the indented children container.
    expect(screen.getByText("nested child")).not.toBeNull();
    expect(container.querySelector(".nt-block-children")).not.toBeNull();

    // Unknown token types never crash the renderer.
    await client.updateObject(nestedParent, {
      contentAst: [
        { type: "text", text: "parent" },
        { type: "future_token_v99", payload: { x: 1 } },
      ] as unknown as ContentAst,
    });
    expect(screen.getByText("parent")).not.toBeNull();
  });

  it("renders placeholder boxes for block-scale tokens", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ nodeType: "page", name: "Placeholders" });
    await client.createObject({
      nodeType: "block",
      parentId: pageId,
      contentAst: [
        { type: "asset_ref", assetId: "0192a000-0000-7000-8000-0000000000a1" },
        { type: "embed_ref", nodeId: "0192a000-0000-7000-8000-0000000000a2" },
        { type: "query", queryAst: { all: true } },
        { type: "whiteboard", layout: {} },
        { type: "math", expression: "E = mc^2" },
        { type: "external_link", href: "https://example.com", text: "Example" },
      ],
    });

    render(<PageView client={client} pageId={pageId} />);

    expect(screen.getByText("asset")).not.toBeNull();
    // embed_ref resolves live when a renderer is present; this target does not
    // exist, so the broken-embed placeholder shows with the raw id visible.
    expect(screen.getByText(/broken embed/)).not.toBeNull();
    expect(screen.getByText("0192a000-0000-7000-8000-0000000000a2")).not.toBeNull();
    expect(screen.getByText("query")).not.toBeNull();
    expect(screen.getByText("whiteboard")).not.toBeNull();
    expect(screen.getByText("E = mc^2").tagName).toBe("CODE");
    const link = screen.getByText("Example");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://example.com");
  });
});
