/**
 * Copy › submenu tests (owner 2026-10-16): the node context menu's clipboard
 * bucket — the node as markdown (its own content, or with its child blocks
 * as nested bullets), the raw node id, and the app link. Runs the real
 * markdown composition (clipboardMarkdown over the in-process
 * WorkspaceClient) and captures the clipboard write through a stubbed
 * navigator.clipboard.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { NodeContextMenu } from "../src/ui/components/NodeContextMenu.js";
import { nodeLinkUrl } from "../src/ui/nodeLink.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.unstubAllGlobals();
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

/** Capture clipboard writes; falls back to the execCommand path without it. */
function stubClipboard() {
  const written: string[] = [];
  vi.stubGlobal("navigator", {
    ...(navigator as object),
    clipboard: {
      writeText: vi.fn(async (text: string) => {
        written.push(text);
      }),
    },
  });
  return written;
}

describe("NodeContextMenu Copy › submenu", () => {
  it("copies the block's own content as markdown (no children)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Question?" }],
    });
    await client.createObject({
      parentId: blockId,
      contentAst: [{ type: "text", text: "Nested detail" }],
    });
    const written = stubClipboard();

    const { getByText } = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: client.getNode(blockId)!, isPage: false }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );

    fireEvent.click(getByText("Copy"));
    fireEvent.click(getByText("Markdown"));

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain("Question?");
    expect(written[0]).not.toContain("Nested detail");
    // The bare-content shape carries no frontmatter noise either way.
    expect(written[0]).not.toContain("isClass:");
  });

  it("copies the block with its children as nested bullets, no frontmatter", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Question?" }],
    });
    await client.createObject({
      parentId: blockId,
      contentAst: [{ type: "text", text: "Nested detail" }],
    });
    const written = stubClipboard();

    const { getByText } = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: client.getNode(blockId)!, isPage: false }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );

    fireEvent.click(getByText("Copy"));
    fireEvent.click(getByText("Markdown with children"));

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain("Question?");
    expect(written[0]).toContain("- Nested detail");
    // Clipboard markdown rides frontmatter OFF (the includeFrontmatter
    // option) — pasted text carries no YAML block.
    expect(written[0]).not.toContain("isClass:");
  });

  it("copies the raw node id and the app link", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Block" }],
    });
    const written = stubClipboard();

    const { getByText, unmount } = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: client.getNode(blockId)!, isPage: false }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );

    fireEvent.click(getByText("Copy"));
    fireEvent.click(getByText("Node id"));
    await waitFor(() => expect(written).toEqual([blockId]));
    unmount();

    const second = stubClipboard();
    const { getByText: getByText2 } = render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node: client.getNode(blockId)!, isPage: false }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
    fireEvent.click(getByText2("Copy"));
    fireEvent.click(getByText2("Link"));
    await waitFor(() => expect(second).toEqual([nodeLinkUrl(blockId)]));
  });
});
