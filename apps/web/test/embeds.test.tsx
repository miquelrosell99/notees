/**
 * Embed tests: live subtree transclusion (EmbedView) over PageView (jsdom).
 * SCHEMA.md normative rule: embeds render the LIVE SUBTREE — the real child
 * nodes, never a clone — so edits re-project through the standard notify/op
 * path. Cycle guard (visited set + depth cap) is a renderer obligation and is
 * covered here including the non-hanging behavior.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

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
    const pageA = await client.createObject({ presentAsMain: true, name: "Host" });
    const target = await client.createObject({ presentAsMain: true, name: "Target Page" });
    await client.createObject({ parentId: target, contentAst: text("child one") });
    const childTwo = await client.createObject({
      parentId: target,
      contentAst: text("child two"),
    });
    await client.createObject({
      parentId: childTwo,
      contentAst: text("grandchild"),
    });
    await client.createObject({ parentId: pageA, contentAst: embed(target) });

    const { container } = render(<PageView client={client} pageId={pageA} />);

    // Live subtree, not a clone: the target's blocks render inside the embed
    // with their nesting intact. (The target's title may also appear in a
    // token span, so scope the name check to the embed header.)
    expect(container.querySelector(".nt-embed-header")?.textContent).toContain("Target Page");
    expect(screen.getByText("child one")).not.toBeNull();
    expect(screen.getByText("child two")).not.toBeNull();
    expect(screen.getByText("grandchild")).not.toBeNull();
    const embedEl = container.querySelector(".nt-embed");
    expect(embedEl).not.toBeNull();
    expect(embedEl?.querySelector(".nt-embed-block-children")).not.toBeNull();
    // Title-is-content: the target page's title IS its content, so the embed
    // body renders it as the content span (the header shows it too).
    expect(embedEl?.querySelector(".nt-embed-content")?.textContent).toContain("Target Page");
  });

  it("re-renders when the target's content changes (notify flow)", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ presentAsMain: true, name: "Host" });
    const holder = await client.createObject({ presentAsMain: true, name: "Holder" });
    const target = await client.createObject({
      parentId: holder,
      contentAst: text("before"),
    });
    await client.createObject({ parentId: pageA, contentAst: embed(target) });

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
    const pageA = await client.createObject({ presentAsMain: true, name: "Host" });
    const holder = await client.createObject({ presentAsMain: true, name: "Holder" });
    const deep = await client.createObject({
      parentId: holder,
      contentAst: text("deep body"),
    });
    const middle = await client.createObject({
      parentId: holder,
      contentAst: embed(deep),
    });
    await client.createObject({ parentId: pageA, contentAst: embed(middle) });

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
    const pageA = await client.createObject({ presentAsMain: true, name: "Host" });
    const holder = await client.createObject({ presentAsMain: true, name: "Holder" });
    // a1 embeds b1, b1 embeds a1 — the renderer must stop at the re-entry.
    const a1 = await client.createObject({ parentId: pageA, contentAst: [] });
    const b1 = await client.createObject({ parentId: holder, contentAst: embed(a1) });
    await client.updateObject(a1, { contentAst: embed(b1) });

    const { container } = render(<PageView client={client} pageId={pageA} />);

    // The test completing already proves no infinite recursion; the guard
    // renders the placeholder at the re-entry point.
    expect(screen.getByText(/recursive embed/)).not.toBeNull();
    expect(container.querySelectorAll(".nt-embed").length).toBe(2);
  });

  it("stops at the depth cap for long chains", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ presentAsMain: true, name: "Host" });
    const holder = await client.createObject({ presentAsMain: true, name: "Holder" });
    // b1 → b2 → … → b7, a 7-deep chain; the cap is 5 rendered embed frames.
    let next = await client.createObject({
      parentId: holder,
      contentAst: text("bottom"),
    });
    for (let i = 6; i >= 1; i -= 1) {
      next = await client.createObject({ parentId: holder, contentAst: embed(next) });
    }
    await client.createObject({ parentId: pageA, contentAst: embed(next) });

    const { container } = render(<PageView client={client} pageId={pageA} />);

    expect(screen.getByText(/max embed depth/)).not.toBeNull();
    expect(container.querySelectorAll(".nt-embed").length).toBe(5);
    expect(screen.queryByText("bottom")).toBeNull();
  });

  it("renders a broken-embed placeholder with the raw id when the target is missing", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ presentAsMain: true, name: "Host" });
    const missing = "0192a000-0000-7000-8000-0000000000ff";
    await client.createObject({ parentId: pageA, contentAst: embed(missing) });

    render(<PageView client={client} pageId={pageA} />);

    expect(screen.getByText(/broken embed/)).not.toBeNull();
    expect(screen.getByText(missing)).not.toBeNull();
  });

  it("the embed header's view switcher writes the token's view field", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ presentAsMain: true, name: "Host" });
    const holder = await client.createObject({
      parentId: pageA,
      contentAst: text("holder body"),
    });
    const hostBlock = await client.createObject({ parentId: pageA, contentAst: embed(holder) });

    const { container } = render(<PageView client={client} pageId={pageA} />);

    // Full embed renders with the switcher; Full is the active view.
    const embedEl = container.querySelector(".nt-embed")!;
    expect(embedEl).not.toBeNull();
    const switcher = () => screen.getByRole("group", { name: "Embed view" });
    expect(switcher()).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: "Full" }) as HTMLButtonElement).getAttribute("aria-pressed"),
    ).toBe("true");

    // Card → the token gains view: "small_card" and the card view renders.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Card" }));
    });
    await act(async () => {});
    expect(client.getNode(hostBlock)?.contentAst).toEqual([
      { type: "embed_ref", nodeId: holder, view: "small_card" },
    ]);
    expect(container.querySelector(".nt-embed-card")).not.toBeNull();

    // Wide → view: "wide_card".
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wide" }));
    });
    await act(async () => {});
    expect(client.getNode(hostBlock)?.contentAst).toEqual([
      { type: "embed_ref", nodeId: holder, view: "wide_card" },
    ]);

    // Back to Full → the view key is CLEARED (absent = the grammar's default).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Full" }));
    });
    await act(async () => {});
    expect(client.getNode(hostBlock)?.contentAst).toEqual([
      { type: "embed_ref", nodeId: holder },
    ]);
    expect(container.querySelector(".nt-embed")).not.toBeNull();
  });

  it("a card-view embed renders the switcher beside the card and switches to the full embed", async () => {
    const client = await seedClient();
    const pageA = await client.createObject({ presentAsMain: true, name: "Host" });
    const target = await client.createObject({ presentAsMain: true, name: "Card Target" });
    const hostBlock = await client.createObject({
      parentId: pageA,
      contentAst: [{ type: "embed_ref", nodeId: target, view: "small_card" }],
    });

    const { container } = render(<PageView client={client} pageId={pageA} />);

    expect(container.querySelector(".nt-embed-card")).not.toBeNull();
    expect(container.querySelector(".nt-embed-card-wrap .nt-embed-view-switch")).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Full" }));
    });
    await act(async () => {});
    expect(client.getNode(hostBlock)?.contentAst).toEqual([
      { type: "embed_ref", nodeId: target },
    ]);
    expect(container.querySelector(".nt-embed")).not.toBeNull();
  });
});
