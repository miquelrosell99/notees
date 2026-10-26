/**
 * The bullet peek gesture (Shift+click a block bullet → the block surfaces
 * as a card in the right rail) across every surface that renders block
 * bullets. Every surface wires the same outliner contract: the bullet's
 * shift+click reads `openInSidebar` from the surface's OutlinerContext —
 * a surface that doesn't wire it silently no-ops (the gesture "does not work" in the views that dropped it).
 *
 * - PageView (the main page body) — the reference wiring.
 * - NodeView on a BLOCK node — the focused block view (the bullet-zoom
 *   surface): the collection self-hosts its outliner, so the host must
 *   pass `onNodeShiftClick` explicitly.
 * - NodeCardFrame (the right rail's peeked cards) — the card's NodeView
 *   needs the peek callback like the main surface's.
 * - FloatingEditorHost (the pinned floating windows) — same contract.
 *
 * Same harness as block-selection.test.tsx (PageView over the in-process
 * WorkspaceClient + MemoryRelay, jsdom).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";
import { NodeView } from "../src/ui/NodeView.js";
import { NodeCardFrame } from "../src/features/collection/NodeCardFrame.js";
import { FloatingEditorHost, openFloatingEditor } from "../src/features/block-editor/FloatingEditor.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
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

/** A page with one child block; returns [pageId, blockId]. */
async function seedPageWithBlock(client: WorkspaceClient): Promise<[string, string]> {
  const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
  const blockId = await client.createObject({
    parentId: pageId,
    contentAst: [{ type: "text", text: "peek target" }],
  });
  return [pageId, blockId];
}

/** Shift+click the bullet of the row whose own content carries `text`. */
function shiftClickBullet(container: HTMLElement, text: string): void {
  const content = Array.from(
    container.querySelectorAll<HTMLElement>(".nt-block-content"),
  ).find((el) => el.textContent?.includes(text));
  if (content === undefined) throw new Error(`no content for ${text}`);
  const row = content.closest<HTMLElement>("[data-block-id]");
  if (row === null) throw new Error(`no row for ${text}`);
  const bullet = row.querySelector<HTMLElement>(".nt-bullet");
  if (bullet === null) throw new Error(`no bullet on row ${text}`);
  fireEvent.click(bullet, { shiftKey: true });
}

describe("the page body (PageView)", () => {
  it("shift+clicking a block bullet peeks the block (the reference wiring)", async () => {
    const client = await seedClient();
    const [pageId, blockId] = await seedPageWithBlock(client);
    const onOpenInSidebar = vi.fn();
    const { container } = render(
      <PageView client={client} pageId={pageId} onOpenInSidebar={onOpenInSidebar} />,
    );

    shiftClickBullet(container, "peek target");
    expect(onOpenInSidebar).toHaveBeenCalledWith(blockId);
  });
});

describe("the focused block view (NodeView on a block)", () => {
  it("shift+clicking a child bullet peeks the child", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const parentId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "zoomed parent" }],
    });
    const kidId = await client.createObject({
      parentId,
      contentAst: [{ type: "text", text: "kid target" }],
    });
    const onOpenInSidebar = vi.fn();
    const { container } = render(
      <NodeView client={client} nodeId={parentId} onOpenInSidebar={onOpenInSidebar} />,
    );

    shiftClickBullet(container, "kid target");
    expect(onOpenInSidebar).toHaveBeenCalledWith(kidId);
  });
});

describe("the right-rail card (NodeCardFrame)", () => {
  it("shift+clicking a block bullet inside the card peeks the block", async () => {
    const client = await seedClient();
    const [pageId, blockId] = await seedPageWithBlock(client);
    const onOpenInSidebar = vi.fn();
    const { container } = render(
      <NodeCardFrame
        client={client}
        nodeId={pageId}
        onOpenNode={() => {}}
        onClose={() => {}}
        onOpenInSidebar={onOpenInSidebar}
      />,
    );

    shiftClickBullet(container, "peek target");
    expect(onOpenInSidebar).toHaveBeenCalledWith(blockId);
  });
});

describe("the floating editor window (FloatingEditorHost)", () => {
  it("shift+clicking a block bullet inside the window peeks the block", async () => {
    const client = await seedClient();
    const [pageId, blockId] = await seedPageWithBlock(client);
    const onOpenInSidebar = vi.fn();
    render(
      <FloatingEditorHost client={client} openNode={() => {}} openInSidebar={onOpenInSidebar}>
        <div />
      </FloatingEditorHost>,
    );

    await act(async () => {
      openFloatingEditor(pageId);
    });

    shiftClickBullet(document.body, "peek target");
    expect(onOpenInSidebar).toHaveBeenCalledWith(blockId);
  });
});
