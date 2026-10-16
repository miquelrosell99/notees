/**
 * Per-block list style (owner 2026-10-16): the listStyle wire node field
 * (store schema v23) — marker derivation (the NUMBER is render-time, never
 * stored: the position within the contiguous run of same-style siblings) and
 * the block-row rendering + context-menu control that write it through the
 * standard object.update path (undo journal + sync pick it up).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { deriveListMarker, formatListMarker } from "../src/ui/listStyle.js";
import { NodeContextMenu } from "../src/ui/components/NodeContextMenu.js";

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

describe("formatListMarker — the marker label per style", () => {
  it("numbered is the plain position, alpha/roman are lowercase glyphs", () => {
    expect(formatListMarker("numbered", 1)).toBe("1.");
    expect(formatListMarker("numbered", 27)).toBe("27.");
    expect(formatListMarker("alpha", 1)).toBe("a.");
    expect(formatListMarker("alpha", 26)).toBe("z.");
    expect(formatListMarker("alpha", 27)).toBe("aa.");
    expect(formatListMarker("alpha", 28)).toBe("ab.");
    expect(formatListMarker("roman", 1)).toBe("i.");
    expect(formatListMarker("roman", 4)).toBe("iv.");
    expect(formatListMarker("roman", 9)).toBe("ix.");
    expect(formatListMarker("roman", 44)).toBe("xliv.");
    expect(formatListMarker("roman", 2026)).toBe("mmxxvi.");
  });
});

describe("deriveListMarker — the number is render-time, never stored", () => {
  const sib = (id: string, listStyle: "numbered" | "alpha" | "roman" | null) => ({
    id,
    parentId: "parent",
    listStyle,
  });

  it("counts the contiguous run of same-style siblings directly above", () => {
    const siblings = [sib("a", "numbered"), sib("b", "numbered"), sib("c", "numbered")];
    expect(deriveListMarker(sib("a", "numbered"), siblings)).toBe("1.");
    expect(deriveListMarker(sib("b", "numbered"), siblings)).toBe("2.");
    expect(deriveListMarker(sib("c", "numbered"), siblings)).toBe("3.");
  });

  it("any sibling without the same style resets the count to 1", () => {
    const siblings = [sib("a", "numbered"), sib("b", null), sib("c", "numbered"), sib("d", "alpha"), sib("e", "numbered")];
    expect(deriveListMarker(sib("c", "numbered"), siblings)).toBe("1.");
    expect(deriveListMarker(sib("e", "numbered"), siblings)).toBe("1.");
  });

  it("nested groups derive independently (per sibling group)", () => {
    const outer = [sib("a", "numbered"), sib("b", "numbered")];
    const inner = [sib("x", "numbered"), sib("y", "numbered")];
    expect(deriveListMarker(sib("y", "numbered"), inner)).toBe("2.");
    expect(deriveListMarker(sib("b", "numbered"), outer)).toBe("2.");
  });

  it("no style / no parent / not among the siblings → null (the bullet renders)", () => {
    const siblings = [sib("a", "numbered")];
    expect(deriveListMarker(sib("a", null), siblings)).toBeNull();
    expect(
      deriveListMarker({ id: "a", parentId: null, listStyle: "numbered" }, siblings),
    ).toBeNull();
    expect(deriveListMarker(sib("zzz", "numbered"), siblings)).toBeNull();
  });
});

describe("listStyle block-row rendering", () => {
  it("styled blocks render derived markers; a style break resets the run", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const first = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "first" }],
    });
    const second = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "second" }],
    });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "breaker" }],
    });
    const fourth = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "fourth" }],
    });
    await client.updateObject(first, { listStyle: "numbered" });
    await client.updateObject(second, { listStyle: "numbered" });
    await client.updateObject(fourth, { listStyle: "numbered" });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const markers = [...container.querySelectorAll(".nt-list-marker")].map(
      (el) => el.textContent,
    );
    // The unstyled "breaker" breaks the run: fourth renumbers from 1.
    expect(markers).toEqual(["1.", "2.", "1."]);
    // The breaker's row still rides the plain dot.
    expect(container.querySelectorAll(".nt-bullet-dot").length).toBeGreaterThan(0);
  });
});

describe("List style › context-menu control", () => {
  it("sets, re-styles, and clears listStyle through object.update", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "target" }],
    });

    const { getByText, unmount } = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: client.getNode(blockId)!, isPage: false }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );

    // One open of the flyout serves all three picks (a subitem click fires
    // the write; the flyout stays for the next pick).
    fireEvent.click(getByText("List style"));
    fireEvent.click(getByText("Numbered"));
    await waitFor(() => expect(client.getNode(blockId)!.listStyle).toBe("numbered"));

    fireEvent.click(getByText("Alphabetical"));
    await waitFor(() => expect(client.getNode(blockId)!.listStyle).toBe("alpha"));

    fireEvent.click(getByText("Bullet"));
    await waitFor(() => expect(client.getNode(blockId)!.listStyle).toBeNull());
    unmount();
  });

  it("marks the current style with the check badge", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "target" }],
    });
    await client.updateObject(blockId, { listStyle: "roman" });

    const { getByText, unmount } = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: client.getNode(blockId)!, isPage: false }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
    fireEvent.click(getByText("List style"));
    // The flyout renders in a body portal — query the document, not the
    // render container.
    const subitems = [...document.querySelectorAll(".context-menu-subitem")];
    const romanRow = subitems.find((el) => el.textContent?.includes("Roman"))!;
    expect(romanRow.querySelector(".context-menu-badge")?.textContent).toBe("✓");
    const bulletRow = subitems.find((el) => el.textContent?.includes("Bullet"))!;
    expect(bulletRow.querySelector(".context-menu-badge")).toBeNull();
    unmount();
  });
});
