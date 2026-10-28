/**
 * Make memorization card: the makeCard helper and the node context-menu
 * entry. makeCard composes the canonical class-assign write path
 * (client.assignClass — the same OR-Set add carrier the class pills and
 * capture flows issue) and is assign-if-absent: membership already present
 * → no write, so re-runs are silent no-ops. The menu entry ("Make
 * memorization card") gates to non-class nodes — a class node itself must
 * not become a card —, hides once the node IS a card, and stays off
 * date-chain nodes (their class set is precision-locked; the write would
 * fail loud anyway).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { dayNodeId, SYSTEM_CLASS_UUIDS } from "@notees/domain";

import type { ClientNode } from "../src/core/workspace-client/index.js";
import { makeCard } from "../src/features/cards/makeCard.js";
import { NodeContextMenu } from "../src/features/node-menu/NodeContextMenu.js";

const CARD = SYSTEM_CLASS_UUIDS.card;

function stubNode(partial: Partial<ClientNode> & { id: string }): ClientNode {
  return {
    workspaceId: "ws1",
    isClass: false,
    isEmbedded: false,
    parentId: null,
    classIds: [],
    tagIds: [],
    name: null,
    contentAst: [{ type: "text", text: "Card candidate" }],
    icon: null,
    coverAssetId: null,
    bannerAssetId: null,
    listStyle: null,
    aliasedNodeId: null,
    parentlessRole: "page",
    description: null,
    color: null,
    isActive: true,
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

/** The makeCard client surface: a node table plus a recorded assignClass. */
function makeCardStub(partial: Partial<ClientNode> & { id: string }) {
  const node = stubNode(partial);
  const writes: { id: string; classId: string }[] = [];
  const client = {
    getNode: (id: string) => (id === node.id ? node : undefined),
    assignClass: async (id: string, classId: string) => {
      writes.push({ id, classId });
      if (!node.classIds.includes(classId)) node.classIds = [...node.classIds, classId];
    },
  };
  return { node, writes, client };
}

describe("makeCard", () => {
  it("class-assigns the card class exactly once on first call", async () => {
    const { node, writes, client } = makeCardStub({ id: "node-1" });
    await makeCard(client, "node-1");
    expect(writes).toEqual([{ id: "node-1", classId: CARD }]);
    expect(node.classIds).toContain(CARD);
  });

  it("is idempotent: a second call emits zero writes", async () => {
    const { writes, client } = makeCardStub({ id: "node-2" });
    await makeCard(client, "node-2");
    await makeCard(client, "node-2");
    expect(writes).toEqual([{ id: "node-2", classId: CARD }]);
  });

  it("no-ops when the node already carries the card class", async () => {
    const { writes, client } = makeCardStub({ id: "node-3", classIds: [CARD] });
    await makeCard(client, "node-3");
    expect(writes).toEqual([]);
  });

  it("refuses a class node — classes never become cards", async () => {
    const { writes, client } = makeCardStub({ id: "class-1", isClass: true });
    await expect(makeCard(client, "class-1")).rejects.toThrow(/class/);
    expect(writes).toEqual([]);
  });

  it("fails loud on an unknown node id", async () => {
    const { client } = makeCardStub({ id: "node-4" });
    await expect(makeCard(client, "nope")).rejects.toThrow(/not found/);
  });
});

describe("Make memorization card — node context menu entry", () => {
  afterEach(() => {
    cleanup();
  });

  /** The MenuClient stub (the share-modal.test.tsx shape) + assignClass spy. */
  function menuClient(node: ClientNode) {
    const assignCalls: { id: string; classId: string }[] = [];
    return {
      assignCalls,
      client: {
        assignClass: async (id: string, classId: string) => {
          assignCalls.push({ id, classId });
        },
        unassignClass: async () => {},
        deleteObject: async () => {},
        updateObject: async () => {},
        getNode: (id: string) => (id === node.id ? node : undefined),
        getChildren: () => [],
        getChildrenFresh: async () => [],
        getEffectiveProperties: () => [],
        createObject: async () => "unused",
        setProperty: async () => {},
        assignProperty: async () => {},
        moveObject: async () => {},
        listPropertySchemas: () => [],
        effectiveClassColor: () => null,
        effectiveClassIcons: () => new Map(),
        effectiveClassParentlessBlock: () => false,
        getDisplayName: () => null,
      },
    };
  }

  function renderMenu(node: ClientNode) {
    const { assignCalls, client } = menuClient(node);
    const view = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node, isPage: !node.parentId }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
    return { assignCalls, ...view };
  }

  it("offers the action on an ordinary block and class-assigns the card class", async () => {
    const { assignCalls, getByText, unmount } = renderMenu(
      stubNode({ id: "block-1", parentId: "page-1" }),
    );
    fireEvent.click(getByText("Make memorization card"));
    await waitFor(() => expect(assignCalls).toEqual([{ id: "block-1", classId: CARD }]));
    unmount();
  });

  it("offers the action on a page", async () => {
    const { assignCalls, getByText } = renderMenu(stubNode({ id: "page-1" }));
    fireEvent.click(getByText("Make memorization card"));
    await waitFor(() => expect(assignCalls).toEqual([{ id: "page-1", classId: CARD }]));
  });

  it("hides the action on a class node", () => {
    renderMenu(stubNode({ id: "class-1", isClass: true }));
    expect(screen.queryByText("Make memorization card")).toBeNull();
  });

  it("hides the action when the node already is a card", () => {
    renderMenu(stubNode({ id: "card-1", classIds: [CARD] }));
    expect(screen.queryByText("Make memorization card")).toBeNull();
  });

  it("hides the action on a date-chain node (the class set is precision-locked)", () => {
    renderMenu(stubNode({ id: dayNodeId("2026-10-28") }));
    expect(screen.queryByText("Make memorization card")).toBeNull();
  });
});
