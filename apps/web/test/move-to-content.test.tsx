/**
 * Move to content: the node context-menu's demote entry (Revision 12 zone
 * flip, parented standalone child back to the inline body). Offered on a
 * parented standalone page child; hidden on date-chain nodes — their journal
 * role is platform-fixed and the write fails loud at the applier's
 * date-chain embedding lock (is-embedded-date-chain.json).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { dayNodeId, monthNodeId } from "@notees/domain";

import type {
  ClientNode,
  ClientWriteOp,
} from "../src/core/workspace-client/index.js";
import type { CloneWriteSurface } from "../src/core/clone.js";
import { NodeContextMenu } from "../src/features/node-menu/NodeContextMenu.js";

function stubNode(partial: Partial<ClientNode> & { id: string }): ClientNode {
  return {
    workspaceId: "ws1",
    isClass: false,
    isEmbedded: false,
    parentId: null,
    classIds: [],
    tagIds: [],
    name: null,
    contentAst: [{ type: "text", text: "Some page" }],
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

describe("Move to content — node context menu entry", () => {
  afterEach(() => {
    cleanup();
  });

  function renderMenu(node: ClientNode) {
    const updateObject = vi.fn(async () => {});
    const client = {
      updateObject,
      assignClass: async () => {},
      unassignClass: async () => {},
      deleteObject: async () => {},
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
      // The batch primitive the clone submit path uses: apply in order
      // through this same stub (clone-bearing specs use the real client).
      async applyOps(this: CloneWriteSurface, ops: ClientWriteOp[]) {
        for (const op of ops) {
          if (op.kind === "create") await this.createObject(op.input);
          else if (op.kind === "update") await this.updateObject(op.id, op.fields);
          else if (op.kind === "setProperty")
            await this.setProperty(
              op.objectId,
              op.propertySchemaId,
              op.value,
              op.idx,
              op.metadata,
            );
          else if (op.kind === "assignProperty")
            await this.assignProperty(op.objectId, op.propertySchemaId);
          else throw new Error(`applyOps: unsupported op kind ${(op as { kind: string }).kind}`);
        }
        return ops.map(() => undefined);
      },
    };
    const view = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node, isPage: !node.parentId }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
    return { updateObject, ...view };
  }

  it("demotes a parented standalone child (the render-bit toggle)", () => {
    const { updateObject, getByText } = renderMenu(
      stubNode({ id: "page-1", parentId: "page-0", isEmbedded: false }),
    );
    fireEvent.click(getByText("Move to content"));
    expect(updateObject).toHaveBeenCalledWith("page-1", { isEmbedded: true });
  });

  it("stays off an inline block (already embedded)", () => {
    renderMenu(stubNode({ id: "block-1", parentId: "page-0", isEmbedded: true }));
    expect(screen.queryByText("Move to content")).toBeNull();
  });

  it("stays off a root page (nothing to return to)", () => {
    renderMenu(stubNode({ id: "root-1", parentId: null, isEmbedded: false }));
    expect(screen.queryByText("Move to content")).toBeNull();
  });

  it("hides the action on a date-chain node (the journal role is platform-fixed)", () => {
    renderMenu(
      stubNode({
        id: dayNodeId("2026-10-28"),
        parentId: monthNodeId("2026-10-28"),
        isEmbedded: false,
      }),
    );
    expect(screen.queryByText("Move to content")).toBeNull();
  });
});
