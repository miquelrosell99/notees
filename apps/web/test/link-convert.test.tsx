/**
 * Node-link context menu — the class-targeted conversion: a mention of a
 * class node converts to an inline class chip (class_link token) and back,
 * the one-off wording riding across as customLabel ↔ displayText. Non-class
 * targets never offer the item. The read-mode host (NodeLinkMenuHost) owns
 * the write through the standard object.update path.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, waitFor, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  NodeLinkMenuHost,
  openNodeLinkMenu,
} from "../src/features/node-menu/NodeLinkContextMenu.js";

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

describe("node-link menu — class-targeted conversion", () => {
  it("converts a mention of a class node to a class chip, keeping the custom label", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Person");
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "meet " },
        { type: "mention", targetNodeId: classId, customLabel: "the person" },
      ],
    });

    render(
      <NodeLinkMenuHost client={client} openNode={() => {}} openInSidebar={() => {}}>
        <div />
      </NodeLinkMenuHost>,
    );
    act(() => openNodeLinkMenu({ blockId, targetNodeId: classId, tokenIndex: 1, x: 0, y: 0 }));

    fireEvent.click(screen.getByText("Convert to class chip"));
    await waitFor(() => {
      const token = client.getNode(blockId)!.contentAst[1] as Record<string, unknown>;
      expect(token.type).toBe("class_link");
      expect(token.classId).toBe(classId);
      expect(token.displayText).toBe("the person");
    });
  });

  it("converts a class chip back to a mention, keeping the display text", async () => {
    const client = await seedClient();
    const classId = await client.createClass("Person");
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "meet " },
        { type: "class_link", classId, displayText: "the person" },
      ],
    });

    render(
      <NodeLinkMenuHost client={client} openNode={() => {}} openInSidebar={() => {}}>
        <div />
      </NodeLinkMenuHost>,
    );
    act(() => openNodeLinkMenu({ blockId, targetNodeId: classId, tokenIndex: 1, x: 0, y: 0 }));

    fireEvent.click(screen.getByText("Convert to link"));
    await waitFor(() => {
      const token = client.getNode(blockId)!.contentAst[1] as Record<string, unknown>;
      expect(token.type).toBe("mention");
      expect(token.targetNodeId).toBe(classId);
      expect(token.customLabel).toBe("the person");
    });
  });

  it("never offers the conversion for a non-class target", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const otherPage = await client.createObject({ isEmbedded: false, name: "Other" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "mention", targetNodeId: otherPage }],
    });

    render(
      <NodeLinkMenuHost client={client} openNode={() => {}} openInSidebar={() => {}}>
        <div />
      </NodeLinkMenuHost>,
    );
    act(() => openNodeLinkMenu({ blockId, targetNodeId: otherPage, tokenIndex: 0, x: 0, y: 0 }));

    expect(screen.getByText("Edit link…")).not.toBeNull();
    expect(screen.queryByText("Convert to class chip")).toBeNull();
    expect(screen.queryByText("Convert to link")).toBeNull();
  });
});
