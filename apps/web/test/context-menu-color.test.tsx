/**
 * Color › node context-menu control: the node color swatch flyout writes
 * object.update color (preset token / null to clear) for ANY node — the
 * color edit that does not require an icon (the page-header picker anchors
 * at the icon or the "Add icon" pill).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeContextMenu } from "../src/features/node-menu/NodeContextMenu.js";

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

describe("Color › context-menu control", () => {
  it("sets and clears the node color through object.update", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "target" }],
    });

    const { unmount } = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: client.getNode(blockId)!, isPage: false }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );

    // The Color submenu trigger row (Copy › and List style › carry the same
    // trigger class; the flyout's own hidden "Color" label would collide
    // with a getByText after it opens).
    const trigger = () =>
      [...document.querySelectorAll(".context-menu-item.has-submenu")].find((el) =>
        el.textContent?.includes("Color"),
      ) as HTMLElement;

    fireEvent.click(trigger());
    // The flyout rides a portal — the swatches are title-labeled buttons.
    fireEvent.click(document.querySelector(".context-menu-submenu-flyout button[title='Green']")!);
    await waitFor(() => expect(client.getNode(blockId)!.color).toBe("green"));

    fireEvent.click(trigger());
    fireEvent.click(
      document.querySelector(".context-menu-submenu-flyout button[title='No color']")!,
    );
    await waitFor(() => expect(client.getNode(blockId)!.color).toBeNull());
    unmount();
  });

  it("marks the current color's swatch as selected", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "target" }],
    });
    await client.updateObject(blockId, { color: "sky" });

    const { getByText, unmount } = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: client.getNode(blockId)!, isPage: false }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
    fireEvent.click(getByText("Color"));
    const selected = document.querySelector(
      ".context-menu-submenu-flyout .context-menu-color-swatch.selected",
    );
    expect(selected?.getAttribute("title")).toBe("Light blue");
    unmount();
  });
});
