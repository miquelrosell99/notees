/**
 * Embed tests: live subtree transclusion (EmbedView) over PageView (jsdom).
 * SCHEMA.md normative rule: embeds render the LIVE SUBTREE — the real child
 * nodes, never a clone — so edits re-project through the standard notify/op
 * path. Cycle guard (visited set + depth cap) is a renderer obligation and is
 * covered here including the non-hanging behavior.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
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

function embed(targetId: string): ContentAst {
  return [{ type: "embed_ref", nodeId: targetId }];
}

function text(value: string): ContentAst {
  return [{ type: "text", text: value }];
}

describe("embeds", () => {
  it("renders the target page's name and its block subtree", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ nodeType: "page", name: "Host" });
    const target = await client.createObject({ nodeType: "page", name: "Target Page" });
    await client.createObject({ nodeType: "block", parentId: target, contentAst: text("child one") });
    const childTwo = await client.createObject({
      nodeType: "block",
      parentId: target,
      contentAst: text("child two"),
    });
    await client.createObject({
      nodeType: "block",
      parentId: childTwo,
      contentAst: text("grandchild"),
    });
    await client.createObject({ nodeType: "block", parentId: pageA, contentAst: embed(target) });

    const { container } = render(<PageView client={client} pageId={pageA} />);

    // Live subtree, not a clone: the target's blocks render inside the embed
    // with their nesting intact.
    expect(screen.getByText("Target Page")).not.toBeNull();
    expect(screen.getByText("child one")).not.toBeNull();
    expect(screen.getByText("child two")).not.toBeNull();
    expect(screen.getByText("grandchild")).not.toBeNull();
    const embedEl = container.querySelector(".nt-embed");
    expect(embedEl).not.toBeNull();
    expect(embedEl?.querySelector(".nt-embed-block-children")).not.toBeNull();
    // A page target has no content of its own — only the header + subtree.
    expect(embedEl?.querySelector(".nt-embed-content")).toBeNull();
  });

  it("re-renders when the target's content changes (notify flow)", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ nodeType: "page", name: "Host" });
    const holder = await client.createObject({ nodeType: "page", name: "Holder" });
    const target = await client.createObject({
      nodeType: "block",
      parentId: holder,
      contentAst: text("before"),
    });
    await client.createObject({ nodeType: "block", parentId: pageA, contentAst: embed(target) });

    const { container } = render(<PageView client={client} pageId={pageA} />);
    // The header also derives the block's name from this content, so assert
    // on the embed's content body specifically.
    const contentEl = () => container.querySelector(".nt-embed-content");
    expect(contentEl()?.textContent).toContain("before");

    await act(async () => {
      await client.updateObject(target, { contentAst: text("after") });
    });

    expect(contentEl()?.textContent).toContain("after");
    expect(contentEl()?.textContent).not.toContain("before");
  });

  it("renders nested embeds inside an embedded subtree", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ nodeType: "page", name: "Host" });
    const holder = await client.createObject({ nodeType: "page", name: "Holder" });
    const deep = await client.createObject({
      nodeType: "block",
      parentId: holder,
      contentAst: text("deep body"),
    });
    const middle = await client.createObject({
      nodeType: "block",
      parentId: holder,
      contentAst: embed(deep),
    });
    await client.createObject({ nodeType: "block", parentId: pageA, contentAst: embed(middle) });

    const { container } = render(<PageView client={client} pageId={pageA} />);

    // Two live embed frames, the inner one inside the outer one's subtree.
    expect(container.querySelectorAll(".nt-embed").length).toBe(2);
    const inner = container.querySelector(".nt-embed .nt-embed");
    expect(inner).not.toBeNull();
    // (The inner header duplicates this text — it is the derived name.)
    expect(inner?.textContent).toContain("deep body");
  });

  it("renders a recursive placeholder for a cycle instead of hanging", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ nodeType: "page", name: "Host" });
    const holder = await client.createObject({ nodeType: "page", name: "Holder" });
    // a1 embeds b1, b1 embeds a1 — the renderer must stop at the re-entry.
    const a1 = await client.createObject({ nodeType: "block", parentId: pageA, contentAst: [] });
    const b1 = await client.createObject({ nodeType: "block", parentId: holder, contentAst: embed(a1) });
    await client.updateObject(a1, { contentAst: embed(b1) });

    const { container } = render(<PageView client={client} pageId={pageA} />);

    // The test completing already proves no infinite recursion; the guard
    // renders the placeholder at the re-entry point.
    expect(screen.getByText(/recursive embed/)).not.toBeNull();
    expect(container.querySelectorAll(".nt-embed").length).toBe(2);
  });

  it("stops at the depth cap for long chains", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ nodeType: "page", name: "Host" });
    const holder = await client.createObject({ nodeType: "page", name: "Holder" });
    // b1 → b2 → … → b7, a 7-deep chain; the cap is 5 rendered embed frames.
    let next = await client.createObject({
      nodeType: "block",
      parentId: holder,
      contentAst: text("bottom"),
    });
    for (let i = 6; i >= 1; i -= 1) {
      next = await client.createObject({ nodeType: "block", parentId: holder, contentAst: embed(next) });
    }
    await client.createObject({ nodeType: "block", parentId: pageA, contentAst: embed(next) });

    const { container } = render(<PageView client={client} pageId={pageA} />);

    expect(screen.getByText(/max embed depth/)).not.toBeNull();
    expect(container.querySelectorAll(".nt-embed").length).toBe(5);
    expect(screen.queryByText("bottom")).toBeNull();
  });

  it("renders a broken-embed placeholder with the raw id when the target is missing", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ nodeType: "page", name: "Host" });
    const missing = "0192a000-0000-7000-8000-0000000000ff";
    await client.createObject({ nodeType: "block", parentId: pageA, contentAst: embed(missing) });

    render(<PageView client={client} pageId={pageA} />);

    expect(screen.getByText(/broken embed/)).not.toBeNull();
    expect(screen.getByText(missing)).not.toBeNull();
  });
});
