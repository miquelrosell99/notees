/**
 * Exit-edit pending echo (the write-echo slice): under the WorkerClient the
 * store's echo lands one RPC after the editor unmounts, so the read-mode
 * swap used to render the stale tree for a visible window ("old content for
 * a couple of seconds"). The row now renders the editor's committed AST as
 * an override until the store's own echo (or an LWW winner naming the node)
 * supersedes it. The stale-echo browser case is simulated with a proxy
 * client whose getBlockTree serves a frozen snapshot until released (the
 * editor-enter-children proxy idiom — the in-process client's reads are
 * always fresh, so a plain spec could never see the window). Red against
 * the old code (read mode shows the pre-edit text), green with the overlay.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import type { BlockTreeNode } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192d000-0000-7000-8000-000000000001";
const ACTOR = "0192d000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  localStorage.clear();
});

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

/**
 * The stale-echo simulation: getBlockTree serves the snapshot captured at
 * the first read (the pre-edit tree) until release() — the write's echo
 * window, held open. Every other read and every write stays real.
 */
function staleTreeClient(real: WorkspaceClient): { client: WorkspaceClient; release: () => void } {
  let frozen: BlockTreeNode[] | null = null;
  let gated = true;
  const client = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "getBlockTree") {
        return (pageId: string, depth?: number) => {
          if (!gated) return real.getBlockTree(pageId, depth);
          if (frozen === null) frozen = real.getBlockTree(pageId, depth);
          return frozen;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as WorkspaceClient;
  return {
    client,
    release: () => {
      gated = false;
    },
  };
}

function clickIntoBlock(container: HTMLElement, index = 0): HTMLElement {
  const contents = container.querySelectorAll<HTMLElement>(".nt-block-content");
  const target = contents[index];
  if (target === undefined) throw new Error(`no .nt-block-content at index ${index}`);
  fireEvent.click(target);
  const editor = target.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

function typeInto(editor: HTMLElement, text: string): void {
  editor.textContent = text;
  fireEvent.input(editor);
}

/** The single body block's rendered text (read mode or editor). */
function blockText(container: HTMLElement): string {
  const content = container.querySelector<HTMLElement>(".nt-block-content");
  if (content === null) throw new Error("no .nt-block-content");
  return content.textContent ?? "";
}

describe("exit-edit pending echo (stale-tree window)", () => {
  it("read mode shows the committed text immediately, never the stale tree's", async () => {
    const real = await seedClient();
    const { client } = staleTreeClient(real);
    const pageId = await real.createObject({ isEmbedded: false, name: "Home" });
    await real.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "old" }] });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await act(async () => {});

    const editor = clickIntoBlock(container, 0);
    typeInto(editor, "new text");
    await act(async () => {});
    // Blur exits edit mode; the tree prop still serves the frozen "old".
    fireEvent.blur(editor);
    await act(async () => {});

    expect(blockText(container)).toBe("new text");
    // The store itself took the write (the echo the gate is holding back).
    expect(real.getBlockTree(pageId)[0]!.node.contentAst).toEqual([{ type: "text", text: "new text" }]);
  });

  it("the store's echo retires the override (identical content renders on)", async () => {
    const real = await seedClient();
    const { client, release } = staleTreeClient(real);
    const pageId = await real.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await real.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "old" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await act(async () => {});

    const editor = clickIntoBlock(container, 0);
    typeInto(editor, "new text");
    await act(async () => {});
    fireEvent.blur(editor);
    await act(async () => {});
    expect(blockText(container)).toBe("new text");

    // Release the echo and poke a re-render: the fresh tree carries the same
    // content — the override retires and the row renders on unchanged.
    release();
    await act(async () => {
      await real.updateObject(blockId, { contentAst: [{ type: "text", text: "new text" }] });
    });
    await act(async () => {});
    expect(blockText(container)).toBe("new text");
  });

  it("an LWW winner naming the node retires the override (remote edit shows)", async () => {
    const real = await seedClient();
    const { client, release } = staleTreeClient(real);
    const pageId = await real.createObject({ isEmbedded: false, name: "Home" });
    const blockId = await real.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "old" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    await act(async () => {});

    const editor = clickIntoBlock(container, 0);
    typeInto(editor, "mine");
    await act(async () => {});
    fireEvent.blur(editor);
    await act(async () => {});
    expect(blockText(container)).toBe("mine");

    // A later write supersedes the override — the change notification names
    // the node, so the row falls back to the tree (still gated: "old"),
    // proving the override no longer masks the store's truth.
    await act(async () => {
      await real.updateObject(blockId, { contentAst: [{ type: "text", text: "winner" }] });
    });
    await act(async () => {});
    expect(blockText(container)).toBe("old");

    release();
    await act(async () => {
      await real.updateObject(blockId, { contentAst: [{ type: "text", text: "winner" }] });
    });
    await act(async () => {});
    expect(blockText(container)).toBe("winner");
  });
});
