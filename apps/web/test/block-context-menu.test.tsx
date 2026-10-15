/**
 * Block text context menu (owner 2026-10-15): right-clicking anywhere on a
 * block's prose opens the same node context menu the bullet grip carries.
 * While editing, the text keeps the editor session's own context-menu flow
 * (mention pills, typed links, browser menu on plain text); read-only
 * projections suppress the native menu without opening anything, exactly
 * like the grip.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { NodeCollection } from "../src/ui/views/index.js";
import type { NodeCollectionItem } from "../src/ui/views/index.js";
import { OutlinerContext, useOutlinerValue } from "../src/ui/outliner-context.js";
import { NodeLinkMenuHost } from "../src/ui/components/NodeLinkContextMenu.js";

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

/** The portaled context menu, when one is open. */
function openMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".context-menu");
}

/**
 * The read-only collection path renders BlockRows without hosting its own
 * OutlinerContext (in the app it rides the enclosing NodeView's) — the
 * wrapper provides the same context the page view would.
 */
function WithOutliner({
  client,
  children,
}: {
  client: WorkspaceClient;
  children: React.ReactNode;
}) {
  const outliner = useOutlinerValue(client, "", { openNode: () => {}, openInSidebar: () => {} });
  return <OutlinerContext.Provider value={outliner}>{children}</OutlinerContext.Provider>;
}

describe("block text right-click (owner 2026-10-15)", () => {
  it("right-clicking the block text opens the node context menu, same as the bullet", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "target prose" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const content = container.querySelector<HTMLElement>(".nt-block-content")!;
    expect(openMenu()).toBeNull();

    // The grip path: the bullet's right-click opens the menu…
    const grip = container.querySelector<HTMLElement>(".nt-block-grip")!;
    fireEvent.contextMenu(grip, { clientX: 8, clientY: 8 });
    expect(openMenu()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(openMenu()).toBeNull();

    // …and the text path opens the same menu.
    fireEvent.contextMenu(content, { clientX: 12, clientY: 12 });
    const menu = openMenu();
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain("Open");
    expect(menu!.textContent).toContain("Delete");
  });

  it("the mention pill keeps its own link menu — it is not overridden by the node menu", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        {
          type: "mention",
          targetNodeId: targetId,
          text: "Target",
          linkId: "0192a000-0000-7000-8000-0000000000aa",
        },
        { type: "text", text: " again" },
      ],
    });

    const { container } = render(
      <NodeLinkMenuHost client={client} openNode={() => {}} openInSidebar={() => {}}>
        <PageView client={client} pageId={pageId} />
      </NodeLinkMenuHost>,
    );
    const pill = container.querySelector<HTMLElement>("button.nt-link")!;
    fireEvent.contextMenu(pill, { clientX: 20, clientY: 20 });

    // Exactly one menu opens, and it is the link menu — not the node menu
    // (the pill preventDefaults on its own onContextMenu; the row-level
    // handler bails on defaultPrevented).
    const menus = document.querySelectorAll<HTMLElement>(".context-menu");
    expect(menus.length).toBe(1);
    expect(menus[0]!.textContent).toContain("Edit link…");
  });

  it("does not open the node menu while the block is being edited", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "editable prose" }],
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const content = container.querySelector<HTMLElement>(".nt-block-content")!;
    fireEvent.click(content);
    const editor = content.querySelector<HTMLElement>(".nt-block-text");
    expect(editor).not.toBeNull();

    // The editing session owns the context menu (mention pills, typed
    // links); a plain-text right-click must not surface the node menu.
    fireEvent.contextMenu(editor!, { clientX: 4, clientY: 4 });
    expect(openMenu()).toBeNull();
  });

  it("read-only projections suppress the native menu without opening anything", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Parent" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "static prose" }],
    });
    const items: NodeCollectionItem[] = [{ node: client.getNode(pageId)! }];

    const { container } = render(
      <WithOutliner client={client}>
        <NodeCollection viewMode="outline" client={client} items={items} tree readOnly onNodeClick={() => {}} />
      </WithOutliner>,
    );
    const content = container.querySelector<HTMLElement>(".nt-block-content")!;
    fireEvent.contextMenu(content, { clientX: 12, clientY: 12 });
    expect(openMenu()).toBeNull();
  });
});
