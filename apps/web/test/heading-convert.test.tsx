/**
 * The heading conversion (owner 2026-10-12) — v1's "Convert to heading"
 * gesture on the content grammar's `heading` token:
 *
 *  - unit: headingConversionOf / headingAstOf / plainTextAstOf cover the
 *    content shapes (single text run ⇄ single heading token; richer
 *    content offers neither direction);
 *  - end to end (jsdom over the in-process WorkspaceClient + MemoryRelay):
 *    the block context menu offers "Convert to heading" for a plain text
 *    block and "Convert to plain text" for a heading block, each writing
 *    through an ordinary undoable object.update.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import {
  headingAstOf,
  headingConversionOf,
  plainTextAstOf,
} from "../src/ui/components/headingConvert.js";
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

/** Flush the microtasks an async client write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

function stubNode(contentAst: unknown): Parameters<typeof headingConversionOf>[0] {
  return { contentAst } as Parameters<typeof headingConversionOf>[0];
}

describe("headingConversionOf (unit)", () => {
  it("a single text run converts to a heading (marks carry); a single heading converts back; richer content offers neither", () => {
    expect(headingConversionOf(stubNode([{ type: "text", text: "Plain" }]))).toBe("to-heading");
    expect(
      headingConversionOf(
        stubNode([{ type: "heading", children: [{ type: "text", text: "Head" }] }]),
      ),
    ).toBe("from-heading");
    // Multi-token, other tokens, and empty content: neither direction.
    expect(
      headingConversionOf(
        stubNode([
          { type: "text", text: "Two" },
          { type: "text", text: "runs" },
        ]),
      ),
    ).toBeNull();
    expect(headingConversionOf(stubNode([{ type: "quote", children: [] }]))).toBeNull();
    expect(headingConversionOf(stubNode([]))).toBeNull();
  });

  it("headingAstOf wraps the run (marks carried); plainTextAstOf flattens the children", () => {
    const withMarks = stubNode([{ type: "text", text: "Bold", marks: ["bold"] }]);
    expect(headingAstOf(withMarks)).toEqual([
      {
        type: "heading",
        children: [{ type: "text", text: "Bold", marks: ["bold"] }],
      },
    ]);
    const plain = stubNode([{ type: "text", text: "Plain" }]);
    expect(headingAstOf(plain)).toEqual([
      { type: "heading", children: [{ type: "text", text: "Plain" }] },
    ]);

    const heading = stubNode([
      {
        type: "heading",
        children: [
          { type: "text", text: "First" },
          { type: "hard_break" },
          { type: "text", text: "second" },
        ],
      },
    ]);
    expect(plainTextAstOf(heading)).toEqual([{ type: "text", text: "First second" }]);
  });
});

describe("the block context menu heading conversion (end to end)", () => {
  async function openMenuFor(client: WorkspaceClient, blockId: string) {
    const node = client.getNode(blockId)!;
    return render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node, isPage: false }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
  }

  it("Convert to heading writes the heading token; Convert to plain text flattens it back", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });
    const block = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Section head" }],
    });

    const first = await openMenuFor(client, block);
    fireEvent.click(screen.getByRole("menuitem", { name: "Convert to heading" }));
    await flushWrites();
    expect(client.getNode(block)!.contentAst).toEqual([
      { type: "heading", children: [{ type: "text", text: "Section head" }] },
    ]);
    first.unmount();

    const second = await openMenuFor(client, block);
    fireEvent.click(screen.getByRole("menuitem", { name: "Convert to plain text" }));
    await flushWrites();
    expect(client.getNode(block)!.contentAst).toEqual([{ type: "text", text: "Section head" }]);
    second.unmount();
  });

  it("a multi-run block offers neither direction", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Doc" });
    const block = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "Two" },
        { type: "text", text: "runs" },
      ],
    });

    await openMenuFor(client, block);
    expect(screen.queryByRole("menuitem", { name: /Convert to heading/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Convert to plain text/ })).toBeNull();
  });
});
