/**
 * Move inline — the class pill's context-menu gesture that turns the pill
 * into an inline class chip: a `class_link` token is prepended to the
 * owner's content (the chip leads, a separating space inserted when text
 * follows), the pill's derived view hides it, and the class MEMBERSHIP
 * stays — the gesture is the inverse of the chip menu's "Remove from
 * inline". The item rides the shared NodeContextMenu every pill surface
 * renders (ClassesRow here); it gates on real membership so non-membership
 * pill rows (the class view's EXTENDS pills) never offer it — a class_link
 * asserts instance-of, not an extends edge.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { ClassesRow } from "../src/features/metadata/ClassesRow.js";
import { ExtendsRow } from "../src/features/classview/xtendsRow.js";
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

/** The portaled context menu (same selector as the node-link suites). */
const openMenu = () => document.body.querySelector<HTMLElement>(".context-menu");

function menuItem(label: string): HTMLElement {
  const menu = openMenu();
  if (menu === null) throw new Error("context menu is not open");
  const item = within(menu)
    .getAllByRole("menuitem")
    .find((el) => el.textContent === label);
  if (item === undefined) throw new Error(`menu item "${label}" not found`);
  return item;
}

describe("Move inline — the class pill's menu", () => {
  async function seedPilledBlock(contentAst: ContentAst, assign = true) {
    const client = await seedClient();
    const classId = await client.createClass("Person");
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({ parentId: pageId, contentAst });
    if (assign) await client.assignClass(blockId, classId);
    return { client, classId, pageId, blockId };
  }

  function renderRow(client: WorkspaceClient, blockId: string, classId: string) {
    return render(<ClassesRow client={client} nodeId={blockId} classIds={[classId]} />);
  }

  function rightClickPill(container: HTMLElement): HTMLElement {
    const pill = container.querySelector<HTMLElement>(".pill");
    if (pill === null) throw new Error("no class pill rendered");
    fireEvent.contextMenu(pill, { clientX: 8, clientY: 8 });
    const menu = openMenu();
    if (menu === null) throw new Error("context menu did not open on the pill");
    return menu;
  }

  it("offers Move inline next to Remove from this node", async () => {
    const { client, classId, blockId } = await seedPilledBlock([
      { type: "text", text: "do something" },
    ]);
    const { container } = renderRow(client, blockId, classId);

    const menu = rightClickPill(container);
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((el) => el.textContent);
    expect(labels).toContain("Move inline");
    expect(labels).toContain("Remove from this node");
    expect(labels.indexOf("Move inline")).toBeLessThan(labels.indexOf("Remove from this node"));
  });

  it("prepends the chip, keeps the text separated, and keeps the membership", async () => {
    const { client, classId, blockId } = await seedPilledBlock([
      { type: "text", text: "do something" },
    ]);
    const { container } = renderRow(client, blockId, classId);

    rightClickPill(container);
    fireEvent.click(menuItem("Move inline"));

    await waitFor(() => {
      expect(client.getNode(blockId)!.contentAst).toEqual([
        { type: "class_link", classId },
        { type: "text", text: " do something" },
      ]);
    });
    // The membership stays — the gesture moves the marker, it doesn't unclass.
    expect(client.getNode(blockId)!.classIds).toContain(classId);
  });

  it("empty content becomes the chip alone", async () => {
    const { client, classId, blockId } = await seedPilledBlock([]);
    const { container } = renderRow(client, blockId, classId);

    rightClickPill(container);
    fireEvent.click(menuItem("Move inline"));

    await waitFor(() => {
      expect(client.getNode(blockId)!.contentAst).toEqual([{ type: "class_link", classId }]);
    });
  });

  it("content already referencing the class is left untouched (idempotent)", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Person");
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "class_link", classId },
        { type: "text", text: " again" },
      ],
    });
    await client.assignClass(blockId, classId);
    // Undo interleavings can re-expose the pill row for an already
    // referenced class — the guard is click-level, so drive the menu
    // directly (the derived view hides the pill, nothing to right-click).
    render(
      <NodeContextMenu
        state={{ x: 8, y: 8, node: client.getNode(classId)!, ownerId: blockId, isPage: true }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );

    fireEvent.click(menuItem("Move inline"));

    await waitFor(() => {
      expect(client.getNode(blockId)!.contentAst).toEqual([
        { type: "class_link", classId },
        { type: "text", text: " again" },
      ]);
    });
  });

  it("stays off a pill the owner is NOT a member of (the extends-row case)", async () => {
    const client = await seedClient();
    const parentClassId = await client.createClass("Parent");
    const childClassId = await client.createClass("Child");
    // The extends edge WITHOUT membership: exactly the class view's row shape.
    await client.setClassExtends(childClassId, [parentClassId]);
    const { container } = render(
      <ClassesRow client={client} nodeId={childClassId} classIds={[parentClassId]} />,
    );

    rightClickPill(container);
    const labels = within(openMenu()!)
      .getAllByRole("menuitem")
      .map((el) => el.textContent);
    expect(labels).not.toContain("Move inline");
  });

  it("an extends pill's 'Remove from this node' writes the EXTENDS relation, not a membership unassign", async () => {
    const client = await seedClient();
    const parentClassId = await client.createClass("Parent");
    const childClassId = await client.createClass("Child");
    await client.setClassExtends(childClassId, [parentClassId]);
    // The production extends row (extendsCornerPills' class.setExtends remove).
    const { container } = render(<ExtendsRow client={client} classId={childClassId} />);

    rightClickPill(container);
    fireEvent.click(menuItem("Remove from this node"));

    await waitFor(() => {
      expect(client.getClassParents(childClassId)).toEqual([]);
    });
    // The membership relation was never touched: no class_link assertion, no
    // classIds row — the old fallback wrote a membership tombstone here.
    expect(client.getNode(childClassId)!.classIds).not.toContain(parentClassId);
  });
});
