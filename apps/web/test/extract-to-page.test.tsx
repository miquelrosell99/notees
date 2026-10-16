/**
 * Block → page extraction tests (owner 2026-10-16): the "Convert to page"
 * context-menu gesture. The composition (extractBlockToPage) is asserted
 * against stub read/write surfaces — the link block lands in the block's
 * old slot (beforeId/afterId anchors), the block moves to the workspace
 * root keeping its identity and content, and the children either stay in
 * the original page (reparented onto the link block, order preserved) or
 * follow the extracted page (keepChildren — no child moves). Plus the menu
 * wiring: the "Convert to page ›" submenu shows for inline blocks only
 * (never pages, never parent-locked date-chain nodes) and each variant is
 * a self-describing plain click.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { dayNodeId } from "@notees/domain";

import { extractBlockToPage } from "../src/core/extractToPage.js";
import type { ClientNode } from "../src/core/workspace-client.js";
import { NodeContextMenu } from "../src/ui/components/NodeContextMenu.js";
import { notificationStore } from "../src/ui/components/ui/notificationStore.js";

const WS = "0192a000-0000-7000-8000-000000000001";

function nodeOf(partial: Partial<ClientNode> & { id: string }): ClientNode {
  return {
    workspaceId: WS,
    isClass: false,
    presentAsMain: false,
    parentId: null,
    classIds: [],
    tagIds: [],
    name: null,
    contentAst: [{ type: "text", text: "Node" }],
    icon: null,
    coverAssetId: null,
    bannerAssetId: null,
    aliasedNodeId: null,
    description: null,
    color: null,
    isActive: true,
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

/** Recording stub surfaces: reads from a fixed map, captures every write. */
function stubSurfaces(entries: Map<string, ClientNode[]>) {
  const nodes = new Map<string, ClientNode>();
  for (const list of entries.values()) for (const n of list) nodes.set(n.id, n);
  const creates: Array<Record<string, unknown>> = [];
  const moves: Array<{
    id: string;
    parentId: string | null;
    afterId?: string | undefined;
    beforeId?: string | undefined;
  }> = [];
  let nextId = 0;
  const reads = {
    getNode: (id: string) => nodes.get(id),
    getChildren: (id: string) => entries.get(id) ?? [],
  };
  const writes = {
    createObject: async (partial: Record<string, unknown>) => {
      creates.push(partial);
      nextId += 1;
      return `link-${nextId}`;
    },
    moveObject: async (
      id: string,
      parentId: string | null,
      afterId?: string | undefined,
      beforeId?: string | undefined,
    ) => {
      moves.push({ id, parentId, afterId, beforeId });
    },
  };
  return { reads, writes, creates, moves };
}

describe("extractBlockToPage composition", () => {
  it("extracts to root, drops a mention link block in the old slot, children stay (order preserved)", async () => {
    const parent = "p1";
    const target = nodeOf({ id: "t1", parentId: parent, contentAst: [{ type: "text", text: "Question?" }] });
    const a = nodeOf({ id: "a1", parentId: parent });
    const b = nodeOf({ id: "b1", parentId: parent });
    const c1 = nodeOf({ id: "c1", parentId: "t1" });
    const c2 = nodeOf({ id: "c2", parentId: "t1" });
    const { reads, writes, creates, moves } = stubSurfaces(
      new Map([
        [parent, [a, target, b]],
        ["t1", [c1, c2]],
      ]),
    );

    const linkId = await extractBlockToPage(reads, writes, "t1");

    expect(linkId).toBe("link-1");
    expect(creates).toEqual([
      {
        parentId: "p1",
        contentAst: [{ type: "mention", targetNodeId: "t1", text: "Question?" }],
        afterId: "a1",
      },
    ]);
    expect(moves).toEqual([
      { id: "t1", parentId: null },
      { id: "c1", parentId: "link-1", afterId: undefined, beforeId: undefined },
      { id: "c2", parentId: "link-1", afterId: "c1", beforeId: undefined },
    ]);
  });

  it("anchors with beforeId when the block is the first child, and bare when it is the only child", async () => {
    const target = nodeOf({ id: "t1", parentId: "p1" });
    const b = nodeOf({ id: "b1", parentId: "p1" });
    const first = stubSurfaces(new Map([["p1", [target, b]]]));
    await extractBlockToPage(first.reads, first.writes, "t1");
    expect(first.creates[0]).toMatchObject({ beforeId: "b1" });
    expect(first.creates[0]).not.toHaveProperty("afterId");

    const only = stubSurfaces(new Map([["p1", [target]]]));
    await extractBlockToPage(only.reads, only.writes, "t1");
    expect(only.creates[0]).not.toHaveProperty("afterId");
    expect(only.creates[0]).not.toHaveProperty("beforeId");
  });

  it("keepChildren moves nothing but the block itself (children follow the page)", async () => {
    const target = nodeOf({ id: "t1", parentId: "p1" });
    const a = nodeOf({ id: "a1", parentId: "p1" });
    const c1 = nodeOf({ id: "c1", parentId: "t1" });
    const { reads, writes, moves } = stubSurfaces(
      new Map([
        ["p1", [a, target]],
        ["t1", [c1]],
      ]),
    );

    await extractBlockToPage(reads, writes, "t1", { keepChildren: true });

    expect(moves).toEqual([{ id: "t1", parentId: null, afterId: undefined, beforeId: undefined }]);
  });

  it("fails loud for a parentless node and a date-chain node, writing nothing", async () => {
    const page = nodeOf({ id: "r1", parentId: null, presentAsMain: true });
    const parentless = stubSurfaces(new Map([["ws-root", [page]]]));
    await expect(extractBlockToPage(parentless.reads, parentless.writes, "r1")).rejects.toThrow(
      /only an inline block/,
    );
    expect(parentless.creates).toEqual([]);
    expect(parentless.moves).toEqual([]);

    const dayId = dayNodeId("2026-10-16");
    const day = nodeOf({ id: dayId, parentId: "m1" });
    const dateLocked = stubSurfaces(new Map([["m1", [day]]]));
    await expect(extractBlockToPage(dateLocked.reads, dateLocked.writes, dayId)).rejects.toThrow(
      /parent-locked/,
    );
    expect(dateLocked.creates).toEqual([]);
    expect(dateLocked.moves).toEqual([]);
  });
});

describe('NodeContextMenu "Convert to page" submenu', () => {
  function stubClient(entries: Map<string, ClientNode[]>) {
    const base = stubSurfaces(entries);
    const client = {
      ...base.writes,
      unassignClass: async () => {},
      deleteObject: async () => {},
      updateObject: async () => {},
      setProperty: async () => {},
      getEffectiveProperties: () => [],
      getNode: base.reads.getNode,
      getChildren: base.reads.getChildren,
      listPropertySchemas: () => [],
      effectiveClassColor: () => null,
      effectiveClassIcons: () => new Map<string, string | null>(),
      getDisplayName: () => null,
    };
    return { client, ...base };
  }

  function renderMenu(node: ClientNode, client: unknown) {
    return render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node, isPage: false }}
        client={client as never}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
  }

  const inlineTarget = nodeOf({
    id: "t1",
    parentId: "p1",
    contentAst: [{ type: "text", text: "Question?" }],
  });
  const scenario = () =>
    new Map<string, ClientNode[]>([
      ["p1", [nodeOf({ id: "a1", parentId: "p1" }), inlineTarget, nodeOf({ id: "b1", parentId: "p1" })]],
      ["t1", [nodeOf({ id: "c1", parentId: "t1" })]],
    ]);

  it("offers the submenu on an inline block only (not pages, not date-chain nodes)", () => {
    // The menu portals to document.body, so each case renders alone and
    // unmounts before the next (default queries bind to the body).
    const shown = renderMenu(inlineTarget, stubClient(scenario()).client);
    expect(shown.queryByText("Convert to page")).not.toBeNull();
    shown.unmount();

    const page = nodeOf({ id: "r1", parentId: null, presentAsMain: true });
    const pageRender = renderMenu(page, stubClient(new Map()).client);
    expect(pageRender.queryByText("Convert to page")).toBeNull();
    pageRender.unmount();

    const mainChild = nodeOf({ id: "m1", parentId: "p1", presentAsMain: true });
    const mainRender = renderMenu(mainChild, stubClient(new Map()).client);
    expect(mainRender.queryByText("Convert to page")).toBeNull();
    mainRender.unmount();

    const dayId = dayNodeId("2026-10-16");
    const day = nodeOf({ id: dayId, parentId: "m1" });
    const dayRender = renderMenu(day, stubClient(new Map()).client);
    expect(dayRender.queryByText("Convert to page")).toBeNull();
    dayRender.unmount();
  });

  it("the submenu names all three variants (parent name, both root extractions)", () => {
    const { getByText } = renderMenu(inlineTarget, stubClient(scenario()).client);
    fireEvent.click(getByText("Convert to page"));
    // The stub cannot resolve the parent node itself — the fallback reads
    // "parent"; the production label carries the parent's display name.
    expect(getByText('Keep under "parent"')).not.toBeNull();
    expect(getByText("Extract to root — children stay here")).not.toBeNull();
    expect(getByText("Extract to root — children follow")).not.toBeNull();
  });

  it("a plain click on 'children stay here' reparents the children to the link block", async () => {
    notificationStore.clearAll();
    const stub = stubClient(scenario());
    const { getByText } = renderMenu(inlineTarget, stub.client);

    fireEvent.click(getByText("Convert to page"));
    fireEvent.click(getByText("Extract to root — children stay here"));

    await waitFor(() => expect(stub.moves.map((m) => m.id)).toEqual(["t1", "c1"]));
    expect(stub.creates).toEqual([
      {
        parentId: "p1",
        contentAst: [{ type: "mention", targetNodeId: "t1", text: "Question?" }],
        afterId: "a1",
      },
    ]);
    expect(notificationStore.notifications.at(-1)?.title).toBe("Converted to page");
  });

  it("'children follow' moves nothing but the block itself", async () => {
    notificationStore.clearAll();
    const stub = stubClient(scenario());
    const { getByText } = renderMenu(inlineTarget, stub.client);

    fireEvent.click(getByText("Convert to page"));
    fireEvent.click(getByText("Extract to root — children follow"));

    await waitFor(() =>
      expect(stub.moves).toEqual([{ id: "t1", parentId: null, afterId: undefined, beforeId: undefined }]),
    );
    expect(stub.creates).toHaveLength(1);
  });
});
