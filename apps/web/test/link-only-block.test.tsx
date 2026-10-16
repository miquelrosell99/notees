/**
 * Link-only block transclusion (Revision 12, SCHEMA.md "Node structure" —
 * the link-based display transformation): a block whose ENTIRE content is a
 * single mention/link to another node presents that node in its place — the
 * web editor renders the referenced node's content inline in place
 * (transclusion-style), regardless of the referenced node's structural role.
 * A block that mixes a link with other content keeps the ordinary mention
 * chip; a block without a link renders normally. Presentation only: the
 * contentAst stays a mention (editing, sync, undo unchanged).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { NodeView } from "../src/ui/App.js";
import { linkOnlyMentionTarget } from "../src/ui/linkOnlyBlock.js";

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

describe("linkOnlyMentionTarget (the strict single-mention trigger)", () => {
  const mention = { type: "mention", targetNodeId: "t1", text: "Target" } as const;

  it("matches exactly one mention token and nothing else", () => {
    expect(linkOnlyMentionTarget([{ ...mention }])).toBe("t1");
    expect(linkOnlyMentionTarget([])).toBeNull();
    expect(
      linkOnlyMentionTarget([{ ...mention }, { type: "text", text: " and more" }]),
    ).toBeNull();
    expect(linkOnlyMentionTarget([{ type: "text", text: "plain" }])).toBeNull();
  });
});

describe("link-only block display transformation", () => {
  it("a block whose whole content is one mention renders the target's content inline in place", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Host" });
    const targetId = await client.createObject({
      isEmbedded: false,
      name: "Target page",
      contentAst: [{ type: "text", text: "the target's own body" }],
    });
    await client.createObject({
      parentId: pageId,
      name: "",
      contentAst: [{ type: "mention", targetNodeId: targetId, text: "Target page" }],
    });

    const { container } = render(<NodeView client={client} nodeId={pageId} onOpenNode={() => {}} />);

    // The referenced node's content renders inside the block row (the
    // transclusion), not merely a mention chip: the embed header names the
    // target and its body follows (title-is-content: the target's title IS
    // its content text).
    expect(container.querySelector(".nt-embed")).not.toBeNull();
    expect(screen.getAllByText("the target's own body").length).toBeGreaterThanOrEqual(2);
  });

  it("a block mixing a mention with other content keeps the ordinary chip (no transclusion)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Host" });
    const targetId = await client.createObject({ isEmbedded: false, name: "Target page" });
    await client.createObject({
      parentId: pageId,
      name: "",
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: targetId, text: "Target page" },
        { type: "text", text: " for context" },
      ],
    });

    const { container } = render(<NodeView client={client} nodeId={pageId} onOpenNode={() => {}} />);

    expect(container.querySelector(".nt-embed")).toBeNull();
    // The ordinary chip renders the mention target's name.
    expect(screen.getAllByText("Target page").length).toBeGreaterThanOrEqual(1);
  });
});
