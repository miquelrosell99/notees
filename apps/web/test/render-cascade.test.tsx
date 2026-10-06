/**
 * Render-cascade tests (Revision 11): NodeView routes by the isClass /
 * presentAsMain booleans — a class node renders the Class View, a parented
 * node with the render bit unset renders the focused block view (inline
 * body + block chrome), and everything else (parentless or present-as-main)
 * renders the Page View with document chrome. Plus the context-menu zone
 * gestures: "Move to Pages" / "Move to content" issue the presentAsMain
 * toggle through updateObject (one undoable object.update). jsdom
 * environment over the in-process WorkspaceClient + MemoryRelay.
 */

import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient, type ClientNode } from "../src/core/workspace-client.js";
import { NodeView } from "../src/ui/App.js";
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

describe("NodeView render cascade (Revision 11)", () => {
  it("parentless node → PageView (document chrome by the second cascade branch)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Root Document" });

    const { container } = render(<NodeView client={client} nodeId={pageId} onOpenNode={() => {}} />);

    expect(screen.getByRole("heading", { name: "Root Document" })).not.toBeNull();
    expect(container.querySelector(".nt-page")).not.toBeNull();
    expect(container.querySelector(".nt-focused-block")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Extends" })).toBeNull();
  });

  it("parented present-as-main node → PageView (the parent's main-children zone)", async () => {
    const client = await seedClient();
    const parentId = await client.createObject({ presentAsMain: true, name: "Parent" });
    const childId = await client.createObject({
      presentAsMain: true,
      parentId,
      name: "Main Child",
    });

    const { container } = render(<NodeView client={client} nodeId={childId} onOpenNode={() => {}} />);

    expect(screen.getByRole("heading", { name: "Main Child" })).not.toBeNull();
    expect(container.querySelector(".nt-page")).not.toBeNull();
    expect(container.querySelector(".nt-focused-block")).toBeNull();
  });

  it("parented inline node → FocusedBlockView (block chrome, no page header)", async () => {
    const client = await seedClient();
    const parentId = await client.createObject({ presentAsMain: true, name: "Parent" });
    const blockId = await client.createObject({
      parentId,
      contentAst: [{ type: "text", text: "inline body block" }],
    });

    const { container } = render(<NodeView client={client} nodeId={blockId} onOpenNode={() => {}} />);

    // The focused-block shell renders the block itself; the page header
    // (an <h1> title editor) never mounts.
    expect(container.querySelector(".nt-focused-block")).not.toBeNull();
    expect(screen.getByText("inline body block")).not.toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("class node → ClassView regardless of placement facts", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Cascade Class");
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Cascade Class" }] });

    const { container } = render(<NodeView client={client} nodeId={classId} onOpenNode={() => {}} />);

    // The class page is a PageView composition: class root, the extends
    // corner's class-only add affordance, and the Class properties row
    // (renamed from "Property definitions" in the class-page naming
    // sweep — the class node has its own standard Properties section, the
    // definitions carry the distinct name).
    expect(screen.getByRole("button", { name: "Add class extension" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /class properties/i })).not.toBeNull();
    expect(container.querySelector(".nt-class")).not.toBeNull();
    expect(container.querySelector(".nt-focused-block")).toBeNull();
  });
});

describe("NodeContextMenu zone gestures (Move to Pages / Move to content)", () => {
  function menuNode(partial: Partial<ClientNode> & { id: string }): ClientNode {
    return {
      workspaceId: WS,
      isClass: false,
      presentAsMain: false,
      parentId: null,
      classIds: [],
      tagIds: [],
      name: null,
      contentAst: [{ type: "text", text: "Gesture Node" }],
      icon: null,
      color: null,
      isActive: true,
      createdAt: null,
      updatedAt: null,
      ...partial,
    };
  }

  function stubClient() {
    const calls: Array<{ id: string; fields: { presentAsMain?: boolean } }> = [];
    return {
      calls,
      client: {
        unassignClass: async () => {},
        deleteObject: async () => {},
        updateObject: async (id: string, fields: { presentAsMain?: boolean }) => {
          calls.push({ id, fields });
        },
        // Clone surfaces the "Duplicate" item composes through (unused by
        // these move-toggle specs).
        getNode: () => undefined,
        getChildren: () => [],
        getEffectiveProperties: () => [],
        createObject: async () => "unused",
        setProperty: async () => {},
      },
    };
  }

  function renderMenu(node: ClientNode, client: ReturnType<typeof stubClient>["client"]) {
    return render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node, isPage: false }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
  }

  it("a parented inline node offers 'Move to Pages' and toggles the bit on", () => {
    const { client, calls } = stubClient();
    const node = menuNode({ id: "n1", parentId: "p1", presentAsMain: false });
    const { queryByText, getByText } = renderMenu(node, client);

    expect(queryByText("Move to content")).toBeNull();
    fireEvent.click(getByText("Move to Pages"));
    expect(calls).toEqual([{ id: "n1", fields: { presentAsMain: true } }]);
  });

  it("a parented main child offers 'Move to content' and toggles the bit off", () => {
    const { client, calls } = stubClient();
    const node = menuNode({ id: "n2", parentId: "p1", presentAsMain: true });
    const { queryByText, getByText } = renderMenu(node, client);

    expect(queryByText("Move to Pages")).toBeNull();
    fireEvent.click(getByText("Move to content"));
    expect(calls).toEqual([{ id: "n2", fields: { presentAsMain: false } }]);
  });

  it("a parentless node gets neither gesture (it already has document chrome)", () => {
    const { client, calls } = stubClient();
    const node = menuNode({ id: "n3", parentId: null, presentAsMain: true });
    const { queryByText } = renderMenu(node, client);

    expect(queryByText("Move to Pages")).toBeNull();
    expect(queryByText("Move to content")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("promoting a block with rich tokens asks first, naming what will flatten (BC4 guard)", () => {
    const { client, calls } = stubClient();
    const node = menuNode({
      id: "n4",
      parentId: "p1",
      presentAsMain: false,
      contentAst: [
        { type: "text", text: "check " },
        { type: "mention", targetNodeId: "t1", text: "Target" },
        { type: "asset_ref", assetId: "a1" },
      ],
    });
    const { getByText, queryByText, getByRole } = renderMenu(node, client);

    fireEvent.click(getByText("Move to Pages"));
    // The confirmation names the flattening token families; the write has
    // NOT happened yet. The modal latches its node and renders above the
    // (now-closed) menu — in production the host nulls the menu state on
    // close, and the modal must outlive it.
    const dialog = within(getByRole("dialog"));
    expect(dialog.getByText(/flattens its rich content to plain text/)).not.toBeNull();
    expect(dialog.getByText(/mentions, asset attachments/)).not.toBeNull();
    expect(calls).toEqual([]);

    fireEvent.click(dialog.getByText("Cancel"));
    expect(calls).toEqual([]);
    expect(queryByText(/flattens its rich content/)).toBeNull();

    fireEvent.click(getByText("Move to Pages"));
    fireEvent.click(within(getByRole("dialog")).getByText("Move to Pages"));
    expect(calls).toEqual([{ id: "n4", fields: { presentAsMain: true } }]);
  });

  it("Duplicate clones the subtree through the clone engine, provenance-free, after the source", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Source" });
    await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "body" }] });
    const node = client.getNode(pageId)!;
    const onDuplicated = vi.fn();
    const { getByText } = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node, isPage: true }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
        onDuplicated={onDuplicated}
      />,
    );

    fireEvent.click(getByText("Duplicate"));
    await waitFor(() => expect(onDuplicated).toHaveBeenCalledTimes(1));
    const freshId = onDuplicated.mock.calls[0]![0] as string;
    const fresh = client.getNode(freshId)!;
    expect(freshId).not.toBe(pageId);
    expect(fresh.parentId).toBeNull();
    expect(fresh.presentAsMain).toBe(true);
    expect(fresh.contentAst).toEqual([{ type: "text", text: "Source" }]);
    expect(client.getChildren(freshId)).toHaveLength(1);
    expect(client.getChildren(freshId)[0]!.contentAst).toEqual([{ type: "text", text: "body" }]);
    // Provenance-free: the generic duplicate gesture never writes generatedFrom.
    expect(
      client
        .getEffectiveProperties(freshId)
        .some((entry) => entry.propertySchemaId === SYSTEM_PROPERTY_UUIDS.generatedFrom),
    ).toBe(false);
  });

  it("the confirmations survive the menu close: a nulling host unmounts the menu, not the modal", async () => {    // Realistic host: onClose nulls the menu state (BlockRow/PageView
    // pattern). The modal latches its node and must still appear — before
    // the latch, the confirmation unmounted with the menu in every host.
    const { client, calls } = stubClient();
    function Host({ node }: { node: ClientNode }) {
      const [menu, setMenu] = useState<{ x: number; y: number } | null>({ x: 0, y: 0 });
      return (
        <>
          <span>{menu === null ? "menu-closed" : "menu-open"}</span>
          <NodeContextMenu
            state={menu === null ? null : { ...menu, node, isPage: false }}
            client={client}
            onClose={() => setMenu(null)}
            onOpenNode={() => {}}
          />
        </>
      );
    }
    const richNode = menuNode({
      id: "n6",
      parentId: "p1",
      presentAsMain: false,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: "t1", text: "Target" },
      ],
    });
    const { getByText, getByRole, queryByRole } = render(<Host node={richNode} />);

    fireEvent.click(getByText("Move to Pages"));
    expect(getByText("menu-closed")).not.toBeNull();
    const dialog = within(getByRole("dialog"));
    expect(dialog.getByText(/flattens its rich content/)).not.toBeNull();
    fireEvent.click(dialog.getByText("Move to Pages"));
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    expect(calls).toEqual([{ id: "n6", fields: { presentAsMain: true } }]);
  });

  it("the delete confirmation rides the same latch (menu closes, modal survives)", async () => {
    function Host({ node }: { node: ClientNode }) {
      const [menu, setMenu] = useState<{ x: number; y: number } | null>({ x: 0, y: 0 });
      const { client, calls } = stubClient();
      return (
        <>
          <NodeContextMenu
            state={menu === null ? null : { ...menu, node, isPage: true }}
            client={client}
            onClose={() => setMenu(null)}
            onOpenNode={() => {}}
          />
          <span data-testid="calls">{JSON.stringify(calls)}</span>
        </>
      );
    }
    const pageNode = menuNode({ id: "n7", parentId: null, presentAsMain: true });
    const { getByText, getByRole, queryByRole } = render(<Host node={pageNode} />);

    fireEvent.click(getByText("Delete"));
    const dialog = within(getByRole("dialog"));
    expect(dialog.getByText(/This will delete/)).not.toBeNull();
    // Confirm awaits the delete and closes the dialog (the stub records no
    // call — the survival of the modal through the menu close is the pin).
    fireEvent.click(dialog.getByText("Delete"));
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
  });

  it("promoting a block whose rich widgets survive does not ask (whiteboard/query pass through)", () => {
    const { client, calls } = stubClient();
    const node = menuNode({
      id: "n5",
      parentId: "p1",
      presentAsMain: false,
      contentAst: [
        { type: "text", text: "board" },
        { type: "whiteboard", layout: {} },
        { type: "query", queryAst: { all: true } },
      ],
    });
    const { getByText, queryByText } = renderMenu(node, client);

    fireEvent.click(getByText("Move to Pages"));
    expect(queryByText(/flattens its rich content/)).toBeNull();
    expect(calls).toEqual([{ id: "n5", fields: { presentAsMain: true } }]);
  });
});
