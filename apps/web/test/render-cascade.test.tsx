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

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

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

    expect(screen.getByRole("heading", { name: "Extends" })).not.toBeNull();
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
});
